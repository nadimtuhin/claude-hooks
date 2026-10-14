package main

import (
	"strings"
	"testing"
	"time"
)

var perfCodeClasses = map[string]bool{"comment": true, "naming": true, "style": true}

func scanWithinBudget(t *testing.T, name, text string, limit time.Duration) ScanResult {
	t.Helper()
	start := time.Now()
	result := scan(text, newScanOptions("ts", perfCodeClasses, Config{}))
	if elapsed := time.Since(start); elapsed > limit {
		t.Fatalf("%s: scan took %v, want under %v with the default budget on", name, elapsed, limit)
	}
	return result
}

// `a:a:a:` repeated makes declArrowRe quadratic; 499 lines never reached the old every-500th-line clock check.
func TestPathologicalArrowLinesRespectTheBudget(t *testing.T) {
	line := strings.Repeat("a:", 999) + "a"
	scanWithinBudget(t, "a:a:a:", strings.Repeat(line+"\n", 499), time.Second)
}

func TestBudgetIsCheckedOnEveryLine(t *testing.T) {
	tick := 0.0
	ctx := &scanCtx{
		lines:    make([]string, 100),
		now:      func() float64 { tick++; return tick },
		budgetMs: 5,
	}
	visited := 0
	ctx.eachCodeLine(func(int, string) { visited++ })
	if visited > 10 || ctx.truncated == 0 {
		t.Fatalf("visited %d lines, truncated at %d; a 5ms budget must stop within a few lines", visited, ctx.truncated)
	}
}

func TestDeclArrowRequiresAnArrow(t *testing.T) {
	if got := declaredNames("a:a:a:a: (b)"); len(got) != 0 {
		t.Fatalf("no arrow, no names, got %v", got)
	}
	if got := declaredNames("const f = (x) => x"); len(got) != 2 || got[0] != "f" {
		t.Fatalf("keyword and arrow names expected, got %v", got)
	}
}

// One 900KB line of test openers hung both implementations: collectTestBodies had no line-length gate and no clock check.
func TestHugeTestOpenerLineIsSkipped(t *testing.T) {
	classes := map[string]bool{"comment": true, "naming": true, "style": true, "testfile": true}
	start := time.Now()
	scan(strings.Repeat("it('a', (", 100_000), newScanOptions("ts", classes, Config{}))
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("scan took %v, want under 1s", elapsed)
	}
}

func TestTestBodiesStopWhenTheBudgetIsSpent(t *testing.T) {
	lines := make([]string, 400)
	for i := range lines {
		lines[i] = "it('a', () => { expect(1).toBe(1); });"
	}
	tick := 0.0
	ctx := &scanCtx{lines: lines, now: func() float64 { tick++; return tick }, budgetMs: 5}
	if got := ctx.testBodies(); len(got) > 10 {
		t.Fatalf("collected %d bodies after the budget was spent", len(got))
	}
}

func TestRepeatedLineIsConvertedToUnitsOnce(t *testing.T) {
	line := "const résumé = compute(😀, 42); // note"
	first := utf16Units(line)
	second := utf16Units(string(append([]byte(nil), line...)))
	if &first[0] != &second[0] {
		t.Fatal("converting the same line twice allocated twice, want the cached units")
	}
	other := utf16Units("different line")
	if string(fromUnits(other)) != "different line" || string(fromUnits(first)) != line {
		t.Fatal("cache returned units for the wrong string")
	}
}

var perfTestfileClasses = map[string]bool{"comment": true, "naming": true, "style": true, "testfile": true}

func scanTestfile(t *testing.T, name, text string, limit time.Duration) {
	t.Helper()
	start := time.Now()
	scan(text, newScanOptions("ts", perfTestfileClasses, Config{}))
	if elapsed := time.Since(start); elapsed > limit {
		t.Fatalf("%s: scan took %v, want under %v", name, elapsed, limit)
	}
}

// Every `/*` in a glob opens a block comment that never closes; the lazy regex rescans to the end of the body for each one.
func TestGlobHeavyTestBodyIsScannedQuickly(t *testing.T) {
	body := strings.Repeat("    expect(match('src/*.ts', 'a/b.ts')).toBe(true);\n", 1500)
	scanTestfile(t, "glob body", "it('globs', () => {\n"+body+"});\n", time.Second)
}

func TestUnclosedBlockCommentOpenersAreLinear(t *testing.T) {
	scanTestfile(t, "60KB of /* ", "it('x', () => {\n"+strings.Repeat("/* ", 20_000)+"\n});\n", time.Second)
}

func TestStripCommentsMatchesTheRegexReplacement(t *testing.T) {
	cases := map[string][]string{
		"a /* b */ c":              {"a  c"},
		"a /* b */ c /* d */ e":    {"a  c  e"},
		"a /*/ b */ c":             {"a  c"},
		"a /* open\nstill */ b":    {"a  b"},
		"a /* unclosed /* b":       {"a /* unclosed /* b"},
		"x /* a */ y /* open":      {"x  y /* open"},
		"x // tail /* not a block": {"x "},
		"/**/":                     {""},
		"/***/ k":                  {" k"},
		"s = 'src/*.ts'; // c":     {"s = 'src/*.ts'; "},
	}
	for in, want := range cases {
		got := stripComments(in)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("stripComments(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPragmaPassSkipsLongLinesWithoutAPragma(t *testing.T) {
	line := "a" + strings.Repeat("//x", 20_000) + "\r"
	start := time.Now()
	pragmaMap([]string{line}, "ts")
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("pragmaMap took %v on a line with no pragma, want under 1s", elapsed)
	}
}

func TestCommitMessageLineOfCommentOpenersDoesNotStall(t *testing.T) {
	message := "a" + strings.Repeat("//x", 15_000) + "\r\n\nbody"
	start := time.Now()
	scan(message, newScanOptions("unknown", map[string]bool{"commit": true}, Config{}))
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("commit scan took %v, want under 1s", elapsed)
	}
}

func TestPragmaAfterManyCommentOpenersStillApplies(t *testing.T) {
	got := pragmaMap([]string{"const userObject = 1; " + strings.Repeat("//x", 50) + " slop-ok: naming-redundant-type-suffix"}, "ts")
	if !got.byLine[1]["naming-redundant-type-suffix"] || !got.byLine[2]["naming-redundant-type-suffix"] {
		t.Fatalf("pragma lost: %+v", got)
	}
}

// In (?:\\.|(?!\1).)* a backslash can be consumed by either branch, so a failing match tries 2^n splits.
func TestQuotedTitleRegexesAreLinearOnBackslashRuns(t *testing.T) {
	slashes := strings.Repeat(`\`, 36)
	cases := map[string]func(){
		"testTitleRe":     func() { testTitleRe.Find("it('" + slashes) },
		"testOpenerRe":    func() { testOpenerRe.Find("it('" + slashes) },
		"quotedLiteralRe": func() { quotedLiteralRe.ReplaceAll("'"+slashes, "§") },
	}
	for name, run := range cases {
		start := time.Now()
		run()
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("%s took %v on a quote and 36 backslashes, want under 1s", name, elapsed)
		}
	}
}

func TestQuotedTitleRegexesStillMatchEscapesAndStopAtLineBreaks(t *testing.T) {
	if m := testTitleRe.Find(`it('it\'s ok\\', () => {})`); m == nil {
		t.Fatal("escaped quote and escaped backslash must stay inside the title")
	} else if g, _ := m.Group(2); g != `it\'s ok\\` {
		t.Fatalf("title = %q", g)
	}
	if m := testOpenerRe.Find(`it("a \"b\" c", async () => {`); m == nil {
		t.Fatal("opener with escaped quotes must match")
	}
	if got := quotedLiteralRe.ReplaceAll("a 'x\ny' b", "§"); got != "a 'x\ny' b" {
		t.Fatalf("a literal must not span a line break, got %q", got)
	}
	if got := quotedLiteralRe.ReplaceAll(`f('a\'b', "c")`, "§"); got != "f(§, §)" {
		t.Fatalf("got %q", got)
	}
}
