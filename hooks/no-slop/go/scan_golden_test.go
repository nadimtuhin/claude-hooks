package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type goldenFinding struct {
	RuleID   string `json:"ruleId"`
	Severity string `json:"severity"`
	Line     int    `json:"line"`
	Excerpt  string `json:"excerpt"`
	Message  string `json:"message"`
	Fix      string `json:"fix"`
}

type scanCase struct {
	Text      string          `json:"text"`
	Lang      string          `json:"lang"`
	Classes   []string        `json:"classes"`
	Config    json.RawMessage `json:"config"`
	Error     string          `json:"error"`
	Findings  []goldenFinding `json:"findings"`
	Truncated *int            `json:"truncated"`
}

func readJSONL[T any](t *testing.T, path string) []T {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []T
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var v T
		if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func classSet(names []string) map[string]bool {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	return set
}

func mustConfig(t *testing.T, raw json.RawMessage) Config {
	t.Helper()
	if len(raw) == 0 || string(raw) == "null" {
		return Config{}
	}
	v, err := parseJSON(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := validateConfig(v, ".no-slop.json")
	if err != nil {
		t.Fatalf("config rejected: %v", err)
	}
	return cfg
}

// Expected values were recorded from the Node implementation while it ran slop-rules.test.mjs.
func TestScanMatchesNodeOnRecordedCases(t *testing.T) {
	cases := readJSONL[scanCase](t, "testdata/scan_cases.jsonl")
	if len(cases) < 250 {
		t.Fatalf("expected the recorded corpus, got %d cases", len(cases))
	}
	for i, c := range cases {
		if c.Error != "" {
			v, err := parseJSON(string(c.Config))
			if err != nil {
				t.Fatalf("case %d: %v", i, err)
			}
			if _, err := validateConfig(v, ".no-slop.json"); err == nil || err.Error() != c.Error {
				t.Errorf("case %d: want config error %q, got %v", i, c.Error, err)
			}
			continue
		}
		opts := noBudget(newScanOptions(c.Lang, classSet(c.Classes), mustConfig(t, c.Config)))
		got := scan(c.Text, opts)
		if len(got.Findings) != len(c.Findings) {
			t.Errorf("case %d (%q): %d findings, want %d\n got %+v\nwant %+v", i, trunc(c.Text), len(got.Findings), len(c.Findings), got.Findings, c.Findings)
			continue
		}
		for j, f := range got.Findings {
			w := c.Findings[j]
			if (goldenFinding{f.RuleID, f.Severity, f.Line, f.Excerpt, f.Message, f.Fix}) != w {
				t.Errorf("case %d finding %d (%q):\n got %+v\nwant %+v", i, j, trunc(c.Text), f, w)
			}
		}
		wantTrunc := 0
		if c.Truncated != nil {
			wantTrunc = *c.Truncated
		}
		if got.Truncated != wantTrunc {
			t.Errorf("case %d: truncated %d, want %d", i, got.Truncated, wantTrunc)
		}
	}
}

func trunc(s string) string {
	if len(s) > 80 {
		return s[:80]
	}
	return s
}

func TestRuleContract(t *testing.T) {
	if len(rules) != 32 {
		t.Fatalf("want 32 rules, got %d", len(rules))
	}
	warn, block := 0, 0
	seen := map[string]bool{}
	for _, r := range rules {
		if seen[r.id] {
			t.Errorf("duplicate id %s", r.id)
		}
		seen[r.id] = true
		if r.severity == "warn" {
			warn++
		} else {
			block++
		}
		for _, c := range r.classes {
			if !contains(ruleClasses, c) {
				t.Errorf("%s: bad class %s", r.id, c)
			}
		}
	}
	if warn != 23 || block != 9 {
		t.Errorf("want 23 warn / 9 block, got %d / %d", warn, block)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func codeClasses() map[string]bool { return classSet([]string{"comment", "naming"}) }

func TestSizeGates(t *testing.T) {
	opts := newScanOptions("", codeClasses(), Config{})
	tooManyLines := strings.Repeat("x\n", maxFileLines)
	if f := scan(tooManyLines, opts).Findings; len(f) != 1 || f[0].RuleID != "file-too-large" || f[0].Excerpt != "10001 lines" {
		t.Errorf("line gate: %+v", f)
	}
	tooManyBytes := "const x = 1;\n" + strings.Repeat("y", maxFileBytes+1024)
	if f := scan(tooManyBytes, opts).Findings; len(f) != 1 || f[0].RuleID != "file-too-large" {
		t.Errorf("byte gate: %+v", f)
	}
	long := `const x = "` + strings.Repeat("a", 2100) + `"; // as you requested`
	if f := scan(long, opts).Findings; len(f) != 0 {
		t.Errorf("long line should be skipped: %+v", f)
	}
}

func TestBudgetTruncatesAndCanBeDisabled(t *testing.T) {
	src := strings.Repeat("// as you requested\n", 1199) + "// as you requested"
	var tick float64
	opts := newScanOptions("", codeClasses(), Config{})
	opts.Now = func() float64 { tick += 1000; return tick }
	if r := scan(src, opts); r.Truncated == 0 {
		t.Error("every budget check blows the budget; want a truncation line")
	}
	tick = 0
	opts = noBudget(opts)
	r := scan(src, opts)
	if r.Truncated != 0 || len(r.Findings) != 1200 {
		t.Errorf("budget disabled: truncated=%d findings=%d", r.Truncated, len(r.Findings))
	}
}

func TestBudgetCheckCadenceIsEvery500Lines(t *testing.T) {
	calls := 0
	opts := noBudget(newScanOptions("", classSet([]string{"comment"}), Config{}))
	opts.Now = func() float64 { calls++; return 0 }
	scan(strings.Repeat("x\n", 1199)+"x", opts)
	// one start read, then three checks (lines 0, 500, 1000) for each of the comment rules' passes
	if calls <= 1 || (calls-1)%3 != 0 {
		t.Errorf("unexpected number of clock reads: %d", calls)
	}
}
