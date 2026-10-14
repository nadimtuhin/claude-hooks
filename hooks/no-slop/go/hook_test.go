package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type hookCase struct {
	Fn     string          `json:"fn"`
	Arg    string          `json:"arg"`
	Result json.RawMessage `json:"result"`
}

func TestHookCasesRecordedFromNode(t *testing.T) {
	cases := readJSONL[hookCase](t, "testdata/hook_cases.jsonl")
	if len(cases) < 50 {
		t.Fatalf("expected the recorded hook cases, got %d", len(cases))
	}
	for _, c := range cases {
		switch c.Fn {
		case "commitMessage":
			got, ok := commitMessage(c.Arg)
			if string(c.Result) == "null" {
				if ok {
					t.Errorf("commitMessage(%q) = %q, node says null", c.Arg, got)
				}
				continue
			}
			var want string
			if err := json.Unmarshal(c.Result, &want); err != nil {
				t.Fatal(err)
			}
			if !ok || got != want {
				t.Errorf("commitMessage(%q) = %q (%v), node says %q", c.Arg, got, ok, want)
			}
		case "isExcluded":
			var want bool
			if err := json.Unmarshal(c.Result, &want); err != nil {
				t.Fatal(err)
			}
			if got := isExcluded(c.Arg); got != want {
				t.Errorf("isExcluded(%q) = %v, node says %v", c.Arg, got, want)
			}
		default:
			t.Fatalf("unknown recorded fn %q", c.Fn)
		}
	}
}

func TestRuleIDByteOrderEqualsLocaleCompareOrder(t *testing.T) {
	var want []string
	raw, err := os.ReadFile("testdata/id_order.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	got := []string{"file-too-large", "pragma-bare"}
	for _, r := range rules {
		got = append(got, r.id)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("byte order differs from node localeCompare order\n got %v\nwant %v", got, want)
	}
}

func TestInvalidUTF8DecodesLikeNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/invalid_utf8.bin")
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile("testdata/invalid_utf8.expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var want string
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if got := decodeUTF8(raw); got != want {
		t.Fatalf("decodeUTF8 = %q, node says %q", got, want)
	}
}

func TestSubjectLengthCountsUTF16Units(t *testing.T) {
	subject := strings.Repeat("😀", 51) // 51 code points, 102 UTF-16 units; the limit is 100
	res := scan(subject, newScanOptions("unknown", map[string]bool{"commit": true}, Config{}))
	if !hasRule(res.Findings, "commit-subject-too-long") {
		t.Fatalf("a 102-unit subject must trip commit-subject-too-long, got %+v", res.Findings)
	}
	short := strings.Repeat("😀", 50)
	if hasRule(scan(short, newScanOptions("unknown", map[string]bool{"commit": true}, Config{})).Findings, "commit-subject-too-long") {
		t.Fatal("a 100-unit subject must not trip commit-subject-too-long")
	}
}

func hasRule(findings []Finding, id string) bool {
	for _, f := range findings {
		if f.RuleID == id {
			return true
		}
	}
	return false
}

func TestRenderSplitsSurrogatePairsLikeNode(t *testing.T) {
	excerpt := strings.Repeat("x", 106) + "😀" + strings.Repeat("y", 10)
	out := render([]Finding{{RuleID: "r", Severity: "warn", Line: 3, Excerpt: excerpt, Message: "m", Fix: "f"}}, "")
	want := "      > " + strings.Repeat("x", 106) + "�...\n"
	if !strings.Contains(out+"\n", want) {
		t.Fatalf("render did not reproduce Node's U+FFFD at the cut\n%q", out)
	}
	if got := render([]Finding{{Severity: "block", Line: 1, Excerpt: strings.Repeat("😀", 55)}}, "f.ts"); !strings.Contains(got, "[BLOCK] f.ts:1") || strings.Contains(got, "...") {
		t.Fatalf("a 110-unit excerpt is shown whole, got %q", got)
	}
}

func TestCappedKeepsBlocksAndIsStable(t *testing.T) {
	findings := []Finding{
		{RuleID: "a", Severity: "warn", Line: 5},
		{RuleID: "b", Severity: "warn", Line: 5},
		{RuleID: "c", Severity: "block", Line: 9},
		{RuleID: "d", Severity: "warn", Line: 1},
		{RuleID: "e", Severity: "warn", Line: 2},
	}
	shown, hidden := capped(findings, 3)
	var ids []string
	for _, f := range shown {
		ids = append(ids, f.RuleID)
	}
	if strings.Join(ids, "") != "dabc" || hidden != 1 {
		t.Fatalf("shown %v hidden %d", ids, hidden)
	}
}

func TestDeclaredNamesFindsEveryNameOnALine(t *testing.T) {
	line := "const alpha = 1; let beta = 2; var gamma = 3"
	first := declaredNames(line)
	if strings.Join(first, ",") != "alpha,beta,gamma" {
		t.Fatalf("got %v", first)
	}
	if again := declaredNames(line); strings.Join(again, ",") != strings.Join(first, ",") {
		t.Fatalf("matching must restart per call, got %v", again)
	}
}

// ---------------------------------------------------------------------------
// hook layer, through run()

type repo struct {
	t   *testing.T
	dir string
}

func newRepo(t *testing.T) *repo {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &repo{t, dir}
}

func (r *repo) write(rel, content string) string {
	r.t.Helper()
	p := filepath.Join(r.dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
	return p
}

func (r *repo) path(rel string) string { return filepath.Join(r.dir, rel) }

type result struct {
	code        int
	out, errOut string
}

func runIn(t *testing.T, cwd, stdin string, args ...string) result {
	t.Helper()
	old := processCwd
	processCwd = func() string { return cwd }
	defer func() { processCwd = old }()
	var out, errOut bytes.Buffer
	code := run(args, strings.NewReader(stdin), &out, &errOut)
	return result{code, out.String(), errOut.String()}
}

func (r *repo) run(stdin string, args ...string) result {
	r.t.Helper()
	return runIn(r.t, r.dir, stdin, args...)
}

func jsonPayload(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

type m = map[string]any

func commitPayload(t *testing.T, command string) string {
	return jsonPayload(t, m{"tool_input": m{"command": command}})
}

func writePayload(t *testing.T, file string) string {
	return jsonPayload(t, m{"tool_input": m{"file_path": file}})
}

func TestCrashExitsOneNeverTwo(t *testing.T) {
	testPanicHook = func() { panic("boom") }
	defer func() { testPanicHook = nil }()
	res := runIn(t, t.TempDir(), "", "commit")
	if res.code != 1 || res.errOut != "no-slop: boom\n" || res.out != "" {
		t.Fatalf("got %+v", res)
	}
}

func TestCommitModeExitCodes(t *testing.T) {
	r := newRepo(t)
	res := r.run(commitPayload(t, `git commit -m "Add cutting-edge parser"`), "commit")
	if res.code != 2 || !strings.Contains(res.errOut, "marketing-superlative") {
		t.Fatalf("slop must block: %+v", res)
	}
	for _, c := range []string{`git commit -m "fix null deref in parser"`, "git commit -F msg.txt"} {
		if res := r.run(commitPayload(t, c), "commit"); res.code != 0 || res.out+res.errOut != "" {
			t.Fatalf("%q: %+v", c, res)
		}
	}
	if res := r.run(commitPayload(t, `git commit -m "wip"`), "commit"); res.code != 0 || !strings.Contains(res.out, "commit-filler") {
		t.Fatalf("a warn-only message reports on stdout: %+v", res)
	}
	for _, stdin := range []string{"not json", ""} {
		if res := r.run(stdin, "commit"); res.code != 0 {
			t.Fatalf("garbage stdin %q: %+v", stdin, res)
		}
	}
}

func TestPayloadShapesThatCrashLikeNode(t *testing.T) {
	r := newRepo(t)
	for _, mode := range []string{"write", "commit", "turn"} {
		res := r.run("null", mode)
		if res.code != 1 || !strings.HasPrefix(res.errOut, "no-slop: TypeError: Cannot read properties of null") {
			t.Errorf("%s with a null payload: %+v", mode, res)
		}
	}
	if res := r.run(jsonPayload(t, m{"tool_input": m{"command": []string{"git commit -m x"}}}), "commit"); res.code != 1 {
		t.Errorf("an array command that reads as a commit crashes in node: %+v", res)
	}
	for _, payload := range []string{`[]`, `"str"`, `5`, `{"tool_input":null}`, `{"tool_input":{"command":7}}`, `{"tool_input":{"command":{"a":1}}}`} {
		if res := r.run(payload, "commit"); res.code != 0 {
			t.Errorf("%s: %+v", payload, res)
		}
	}
}

func TestWriteMode(t *testing.T) {
	r := newRepo(t)
	test := r.write("a.test.ts", "it('works', () => {});\n")
	res := r.run(jsonPayload(t, m{"tool_name": "Edit", "tool_input": m{"file_path": test}}), "write")
	if res.code != 2 || !strings.Contains(res.errOut, "testfile-empty-body") || !strings.Contains(res.errOut, "in a.test.ts:") {
		t.Fatalf("%+v", res)
	}
	clean := r.write("clean.ts", "export const two = 1 + 1;\n")
	if res := r.run(writePayload(t, clean), "write"); res.code != 0 || res.errOut != "" {
		t.Fatalf("clean file: %+v", res)
	}
	if res := r.run(writePayload(t, r.path("nope.ts")), "write"); res.code != 0 {
		t.Fatalf("missing file: %+v", res)
	}
	dist := r.write("dist/a.test.ts", "it('works', () => {});\n")
	if res := r.run(writePayload(t, dist), "write"); res.code != 0 {
		t.Fatalf("excluded: %+v", res)
	}
	var many []string
	for i := 0; i < 9; i++ {
		many = append(many, "// set the value "+string(rune('0'+i)), "setTheValue"+string(rune('0'+i))+"();")
	}
	file := r.write("many.ts", strings.Join(many, "\n"))
	res = r.run(writePayload(t, file), "write")
	if strings.Count(res.errOut, "[WARN]") != 3 || !strings.Contains(res.errOut, "more warning(s) — see: no-slop scan many.ts --all") {
		t.Fatalf("warn cap: %+v", res)
	}
	if !strings.HasSuffix(res.errOut, "These are style tripwires, not a build failure. Fix what is genuinely slop and move on.\n") {
		t.Fatalf("closing line: %q", res.errOut)
	}
	nb := jsonPayload(t, m{"tool_input": m{"file_path": nil, "notebook_path": file}})
	if res := r.run(nb, "write"); res.code != 2 {
		t.Fatalf("notebook_path is used when file_path is null: %+v", res)
	}
	for _, bad := range []any{5, true, "", []string{"x"}, m{"a": 1}} {
		if res := r.run(jsonPayload(t, m{"tool_input": m{"file_path": bad}}), "write"); res.code != 0 {
			t.Fatalf("file_path %v: %+v", bad, res)
		}
	}
}

func TestDisableDirectives(t *testing.T) {
	r := newRepo(t)
	file := r.write("d.ts", "// no-slop-disable-next-line comment-provenance\n// as you requested\n// as you requested\n")
	res := r.run("", "scan", file, "--all")
	if res.code != 1 || strings.Count(res.out, "comment-provenance") != 1 || !strings.Contains(res.out, ":3 ") {
		t.Fatalf("only line 3 survives: %+v", res)
	}
	block := r.write("b.ts", "// no-slop-disable *\n// as you requested\n// no-slop-enable\n// per your review feedback\n")
	res = r.run("", "scan", block, "--all")
	if res.code != 1 || strings.Count(res.out, "comment-provenance") != 1 || !strings.Contains(res.out, "b.ts:4 ") {
		t.Fatalf("%+v", res)
	}
	open := r.write("o.ts", "// no-slop-disable comment-provenance\n// as you requested\n// per your review feedback\n")
	if res := r.run("", "scan", open); res.code != 0 {
		t.Fatalf("an unclosed block runs to EOF: %+v", res)
	}
}

func TestTurnModeIsAdvisory(t *testing.T) {
	r := newRepo(t)
	line := func(v any) string { return jsonPayload(t, v) + "\n" }
	assistant := func(blocks ...any) string {
		return line(m{"message": m{"role": "assistant", "content": blocks}})
	}
	slop := m{"type": "text", "text": "You're absolutely right, the lock leaks."}
	turn := func(transcript string) result {
		p := r.write("t.jsonl", transcript)
		return r.run(jsonPayload(t, m{"transcript_path": p}), "turn")
	}
	if res := turn(assistant(slop)); res.code != 0 || !strings.Contains(res.out, "prose-opener") || !strings.HasPrefix(res.out, "no-slop (prose, advisory):\n") {
		t.Fatalf("%+v", res)
	}
	if res := r.run(jsonPayload(t, m{"transcript_path": "/nope"}), "turn"); res.code != 0 || res.out != "" {
		t.Fatalf("missing transcript: %+v", res)
	}
	toolOnly := assistant(slop) + assistant(m{"type": "tool_use", "name": "Bash"})
	if res := turn(toolOnly); !strings.Contains(res.out, "prose-opener") {
		t.Fatalf("tool_use-only entries keep the search going: %+v", res)
	}
	userLast := assistant(slop) + line(m{"message": m{"role": "user", "content": "hi"}})
	if res := turn(userLast); !strings.Contains(res.out, "prose-opener") {
		t.Fatalf("non-assistant entries are skipped: %+v", res)
	}
	malformed := assistant(slop) + "{ not json\n"
	if res := turn(malformed); res.code != 0 || res.out != "" {
		t.Fatalf("a malformed line before text is found abandons the whole turn: %+v", res)
	}
	nullBlock := assistant(slop, nil)
	if res := turn(nullBlock); res.out != "" {
		t.Fatalf("a null content element abandons the turn: %+v", res)
	}
	if res := turn(assistant(m{"type": "text", "text": "  "})); res.out != "" {
		t.Fatalf("blank text: %+v", res)
	}
}

func TestConfigErrorsNameTheFile(t *testing.T) {
	r := newRepo(t)
	target := r.write("cfg.ts", "// as you requested\n")
	cfg := r.path(".no-slop.json")
	set := func(body string) { r.write(".no-slop.json", body) }

	if res := r.run("", "scan", target); res.code != 1 {
		t.Fatalf("baseline finding: %+v", res)
	}
	set(`{"rules":{"comment-provenance":"off"}}`)
	if res := r.run("", "scan", target); res.code != 0 || !strings.Contains(res.out, "clean") {
		t.Fatalf("off: %+v", res)
	}
	r.write("pkg/x.ts", "// as you requested\n")
	r.write("pkg/.no-slop.json", `{"rules":{"comment-provenance":"block"}}`)
	if res := r.run("", "scan", r.path("pkg/x.ts")); res.code != 1 {
		t.Fatalf("leaf wins: %+v", res)
	}

	set(`{ not json`)
	res := r.run("", "scan", target)
	if res.code != 1 || !strings.HasPrefix(res.errOut, "no-slop: "+cfg+": not valid JSON (") || strings.Contains(res.out, "clean") {
		t.Fatalf("%+v", res)
	}
	set(`{"rules":{"comment-provinance":"off"}}`)
	res = r.run("", "scan", target)
	if res.code != 1 || !strings.Contains(res.errOut, `comment-provinance`) || !strings.Contains(res.errOut, cfg) {
		t.Fatalf("%+v", res)
	}
	set(`{"rules":{"comment-provenance":"silent"}}`)
	if res := r.run("", "scan", target); res.code != 1 {
		t.Fatalf("unknown severity: %+v", res)
	}
	set(`{"comment-provenance":"off"}`)
	res = r.run("", "scan", target)
	want := "no-slop: " + cfg + `: expected a top-level "rules" object, e.g. {"rules":{"naming-inflated":"off"}}` + "\n"
	if res.code != 1 || res.errOut != want {
		t.Fatalf("%+v", res)
	}
	set(`{ not json`)
	if res := r.run(writePayload(t, target), "write"); res.code != 1 || !strings.Contains(res.errOut, "not valid JSON") {
		t.Fatalf("write hook fails loud too: %+v", res)
	}
	set(`null`)
	if res := r.run("", "scan", target); res.code != 1 || !strings.Contains(res.errOut, "TypeError") {
		t.Fatalf("null config crashes: %+v", res)
	}
}

func TestBaselineRoundTrip(t *testing.T) {
	r := newRepo(t)
	file := r.write("legacy.ts", "// as you requested\nconst userObject = {};\n")
	payload := writePayload(t, file)
	if res := r.run(payload, "write"); res.code != 2 {
		t.Fatalf("reports before baselining: %+v", res)
	}
	res := r.run("", "baseline", r.dir)
	if res.code != 0 || !strings.Contains(res.out, "baselined 2 existing finding(s) across 1 file(s)") || !strings.Contains(res.out, "wrote .no-slop-baseline.json — only NEW findings will be reported from here.\n") {
		t.Fatalf("%+v", res)
	}
	if res := r.run(payload, "write"); res.code != 0 {
		t.Fatalf("silent after baselining: %+v", res)
	}
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("// per your review feedback\n")
	f.Close()
	res = r.run(payload, "write")
	if res.code != 2 || strings.Count(res.errOut, "comment-provenance") != 1 {
		t.Fatalf("a new finding still fires: %+v", res)
	}
	if res := r.run("", "scan", file, "--no-baseline"); res.code != 1 {
		t.Fatalf("--no-baseline shows everything: %+v", res)
	}
	r.write(".no-slop-baseline.json", "{ nope")
	res = r.run(payload, "write")
	if res.code != 1 || !strings.Contains(res.errOut, `. Delete it or re-run "no-slop baseline".`) {
		t.Fatalf("a corrupt baseline is a hard error: %+v", res)
	}
}

func TestBaselineFileIsByteIdenticalToJSONStringify(t *testing.T) {
	r := newRepo(t)
	r.write("b<&>.ts", "// as you requested\n")
	r.write("a x.ts", "// as you requested\nconst userObject = {};\n")
	r.write("clean.ts", "export const two = 1 + 1;\n")
	if res := r.run("", "baseline", r.dir); res.code != 0 {
		t.Fatalf("%+v", res)
	}
	got, err := os.ReadFile(r.path(".no-slop-baseline.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"version\": 1,\n  \"findings\": {\n    \"a x.ts\": [\n      \"1:comment-provenance\",\n      \"2:naming-redundant-type-suffix\"\n    ],\n    \"b<&>.ts\": [\n      \"1:comment-provenance\"\n    ]\n  }\n}\n"
	if string(got) != want {
		t.Fatalf("baseline bytes differ\n got %q\nwant %q", got, want)
	}
}

func TestBaselineOfNothingIsEmptyObject(t *testing.T) {
	r := newRepo(t)
	r.write("clean.ts", "export const two = 1 + 1;\n")
	r.run("", "baseline", r.dir)
	got, _ := os.ReadFile(r.path(".no-slop-baseline.json"))
	if string(got) != "{\n  \"version\": 1,\n  \"findings\": {}\n}\n" {
		t.Fatalf("%q", got)
	}
}

func TestBaselineValueShapesLikeNode(t *testing.T) {
	r := newRepo(t)
	file := r.write("x.ts", "// as you requested\n")
	for body, want := range map[string]int{
		`{"findings":{"x.ts":["1:comment-provenance"]}}`: 0,
		`{"findings":{"x.ts":"1:comment-provenance"}}`:   1,
		`{"findings":{"x.ts":null}}`:                     1,
		`{"findings":null}`:                              1,
		`{"findings":{"x.ts":[7]}}`:                      1,
		`[]`:                                             1,
		`5`:                                              1,
		`{"findings":{"x.ts":5}}`:                        -1,
		`{"findings":{"x.ts":{}}}`:                       -1,
		`null`:                                           -1,
	} {
		r.write(".no-slop-baseline.json", body)
		res := r.run("", "scan", file)
		if want == -1 {
			if res.code != 1 || !strings.HasPrefix(res.errOut, "no-slop: TypeError") {
				t.Errorf("%s should crash like node: %+v", body, res)
			}
		} else if res.code != want || res.errOut != "" {
			t.Errorf("%s: %+v", body, res)
		}
	}
}

func TestCliSurface(t *testing.T) {
	r := newRepo(t)
	if res := r.run("", "--help"); res.code != 0 || res.out != usageText {
		t.Fatalf("%+v", res)
	}
	if res := r.run(""); res.code != 0 || res.out != usageText {
		t.Fatalf("%+v", res)
	}
	if res := r.run("", "bogus"); res.code != 1 || res.errOut != "no-slop: unknown mode \"bogus\"\n\n"+usageText {
		t.Fatalf("%+v", res)
	}
	if res := r.run("", "scan"); res.code != 1 || res.errOut != "no-slop: scan needs a path, or --stdin\n" {
		t.Fatalf("%+v", res)
	}
	if res := r.run("", "scan", r.path("missing.ts")); res.code != 1 || res.errOut != "no-slop: no such path: "+r.path("missing.ts")+"\n" {
		t.Fatalf("%+v", res)
	}
	warnOnly := r.write("warnonly.ts", "const userObject = {};\n")
	if res := r.run("", "scan", warnOnly, "--severity=block"); res.code != 0 {
		t.Fatalf("%+v", res)
	}
	if res := r.run("", "scan", warnOnly); res.code != 1 || !strings.Contains(res.out, "no-slop: 1 finding(s)\n") {
		t.Fatalf("%+v", res)
	}
	if res := r.run("", "scan", r.dir, "--severity=loud"); res.code != 1 || res.errOut != "no-slop: --severity must be \"warn\" or \"block\", got \"loud\"\n" {
		t.Fatalf("%+v", res)
	}
	res := r.run("wip\x00fix null deref in parser\x00", "scan", "--stdin", "--commit", "--all")
	if !strings.Contains(res.out, "<stdin> message 1") || strings.Contains(res.out, "message 2:") {
		t.Fatalf("%+v", res)
	}
	res = r.run("wip\n\nbody\n", "scan", "--stdin", "--commit")
	if want := "no-slop: no NUL separator found — treating stdin as a single message.\nno-slop: for per-commit results use: git log -300 --format=%B%x00\n"; res.errOut != want {
		t.Fatalf("%q", res.errOut)
	}
}

func TestSplitCommitStream(t *testing.T) {
	got := splitCommitStream("a\x00\nb \x1e\n\n c\x00")
	if strings.Join(got, "|") != "a|b|c" {
		t.Fatalf("%q", got)
	}
}

func TestWalkSkipsHiddenExcludedAndUnscannable(t *testing.T) {
	r := newRepo(t)
	for _, f := range []string{"b.ts", "a.ts", "sub/c.py", ".hidden/d.ts", "node_modules/e.ts", "notes.txt", "x.min.js", "sub/deeper/f.md"} {
		r.write(f, "x\n")
	}
	var rel []string
	for _, p := range walk(r.dir) {
		rel = append(rel, strings.TrimPrefix(p, r.dir+"/"))
	}
	if strings.Join(rel, ",") != "a.ts,b.ts,sub/c.py,sub/deeper/f.md" {
		t.Fatalf("%v", rel)
	}
}

func TestPrebuiltRegexesAllCompiledWithECMAScript(t *testing.T) {
	for _, r := range jsRegistry {
		if r.re == nil {
			t.Fatalf("%s did not compile", r.src)
		}
	}
}
