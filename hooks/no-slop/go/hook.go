package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"syscall"
)

const (
	baselineFile = ".no-slop-baseline.json"
	configFile   = ".no-slop.json"
	warnCap      = 3
)

var (
	mdPathRe       = mustJS(`\.mdx?$`, true)
	nextLineDirRe  = mustJS(`no-slop-disable-next-line\s+(\*|\S+)`, false)
	disableDirRe   = mustJS(`no-slop-disable\s+(\*|\S+)`, false)
	enableDirRe    = mustJS(`no-slop-enable\b`, false)
	commitGateRe   = mustJS(`\bgit\b[^\n]*\bcommit\b`, false)
	commitWordRe   = mustJS(`\bcommit\b`, false)
	opaqueFlagRe   = mustJS(`\s(?:-F|--file|--template|-t|-C|--reuse-message|--amend\b(?![^\n]*-m))\b`, false)
	heredocRe      = mustJS(`<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\s*\2\s*$|<<-?\s*(['"]?)(\w+)\4\s*\n([\s\S]*?)\n\s*\5\b`, false)
	shortMessageRe = mustJS(`^-[a-zA-Z]*m$`, false)
	storedSepRe    = mustJS(`[\x00\x1e]`, false)
)

// hookError is a failure the hook reports as `no-slop: <msg>` with exit 1, the way die() and uncaught throws do in Node.
type hookError struct{ msg string }

func (e hookError) Error() string { return e.msg }

func die(format string, args ...any) { panic(hookError{fmt.Sprintf(format, args...)}) }

func typeErrorReading(prop string) {
	panic(hookError{fmt.Sprintf("TypeError: Cannot read properties of null (reading '%s')", prop)})
}

type app struct {
	stdin      io.Reader
	out        *bytes.Buffer
	err        *bytes.Buffer
	unbudgeted bool
}

func (a *app) scanOpts(lang string, classes map[string]bool, config Config) ScanOptions {
	o := newScanOptions(lang, classes, config)
	if a.unbudgeted {
		o = noBudget(o)
	}
	return o
}

func (a *app) scan(text, lang string, classes map[string]bool, config Config) []Finding {
	return scan(text, a.scanOpts(lang, classes, config)).Findings
}

func (a *app) readStdin() string {
	if a.stdin == nil {
		return ""
	}
	b, _ := io.ReadAll(a.stdin)
	return decodeUTF8(b)
}

func (a *app) readPayload() *jval {
	raw := jsTrim(a.readStdin())
	if raw == "" {
		return newObject()
	}
	v, err := parseJSON(raw)
	if err != nil {
		return newObject()
	}
	return v
}

func nullish(v *jval) bool { return v == nil || v.kind == jNull }
func falsy(v *jval) bool   { return v == nil || !v.truthy() }

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// fsMessage renders an fs error the way Node's err.message does, so uncaught failures read the same.
func fsMessage(err error, op, p string) string {
	switch {
	case errors.Is(err, syscall.EISDIR):
		return "EISDIR: illegal operation on a directory, read"
	case errors.Is(err, syscall.EACCES):
		return fmt.Sprintf("EACCES: permission denied, %s '%s'", op, p)
	case errors.Is(err, syscall.ENOENT):
		return fmt.Sprintf("ENOENT: no such file or directory, %s '%s'", op, p)
	case errors.Is(err, syscall.ENOTDIR):
		return fmt.Sprintf("ENOTDIR: not a directory, %s '%s'", op, p)
	case errors.Is(err, syscall.EROFS):
		return fmt.Sprintf("EROFS: read-only file system, %s '%s'", op, p)
	}
	return err.Error()
}

func readText(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", errors.New(fsMessage(err, "open", p))
	}
	return decodeUTF8(b), nil
}

func mustReadText(p string) string {
	text, err := readText(p)
	if err != nil {
		panic(hookError{"Error: " + err.Error()})
	}
	return text
}

// ---------------------------------------------------------------------------
// repo, config, baseline

func repoRoot(from string) (string, bool) {
	dir := pathResolve(from)
	for {
		if exists(pathJoin(dir, ".git")) {
			return dir, true
		}
		up := pathDirname(dir)
		if up == dir {
			return "", false
		}
		dir = up
	}
}

func loadConfig(dir string) Config {
	start := pathResolve(dir)
	root, hasRoot := repoRoot(start)
	chain := []string{}
	for cur := start; ; {
		chain = append([]string{cur}, chain...)
		if hasRoot && cur == root {
			break
		}
		up := pathDirname(cur)
		if up == cur {
			break
		}
		cur = up
	}
	merged := Config{}
	for _, d := range chain {
		file := pathJoin(d, configFile)
		if !exists(file) {
			continue
		}
		mergeConfig(merged, loadConfigFile(file))
	}
	return merged
}

func loadConfigFile(file string) Config {
	text, err := readText(file)
	var parsed *jval
	if err == nil {
		parsed, err = parseJSON(text)
	}
	if err != nil {
		die("%s: not valid JSON (%s)", file, err.Error())
	}
	if parsed.kind == jNull {
		typeErrorReading("rules")
	}
	rules := parsed.member("rules")
	if rules == nil || (rules.kind != jObj && rules.kind != jArr) {
		die(`%s: expected a top-level "rules" object, e.g. {"rules":{"naming-inflated":"off"}}`, file)
	}
	normalized, verr := validateConfig(rules, file)
	if verr != nil {
		die("%s", verr.Error())
	}
	return normalized
}

type baseline struct {
	dir  string
	data *jval
}

func findBaseline(from string) *baseline {
	dir := pathResolve(from)
	for {
		file := pathJoin(dir, baselineFile)
		if exists(file) {
			text, err := readText(file)
			var data *jval
			if err == nil {
				data, err = parseJSON(text)
			}
			if err != nil {
				die(`%s: not valid JSON (%s). Delete it or re-run "no-slop baseline".`, file, err.Error())
			}
			return &baseline{dir, data}
		}
		up := pathDirname(dir)
		if up == dir {
			return nil
		}
		dir = up
	}
}

func baselineKey(f Finding) string { return fmt.Sprintf("%d:%s", f.Line, f.RuleID) }

func notIterable(v *jval) {
	what := "object"
	switch v.kind {
	case jNum, jBool:
		what = fmt.Sprintf("%s %s", map[jkind]string{jNum: "number", jBool: "boolean"}[v.kind], v.toString())
	}
	panic(hookError{fmt.Sprintf("TypeError: %s is not iterable (cannot read property Symbol(Symbol.iterator))", what)})
}

func applyBaseline(findings []Finding, b *baseline, absPath string) []Finding {
	if b == nil {
		return findings
	}
	if b.data.kind == jNull {
		typeErrorReading("findings")
	}
	known := map[string]bool{}
	if all := b.data.member("findings"); !nullish(all) {
		if v := all.member(pathRelative(b.dir, absPath)); !nullish(v) {
			switch v.kind {
			case jArr:
				for _, e := range v.arr {
					if e.kind == jStr {
						known[e.s] = true
					}
				}
			case jStr:
			default:
				notIterable(v)
			}
		}
	}
	var out []Finding
	for _, f := range findings {
		if !known[baselineKey(f)] {
			out = append(out, f)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// scanning a file on disk

func isExcluded(p string) bool {
	return excludedDirRe.Test(p) || excludedFileRe.Test(pathBasename(p))
}

func classesFor(filePath string) map[string]bool {
	set := map[string]bool{"comment": true, "naming": true, "style": true}
	if testPathRe.Test(filePath) {
		set["testfile"] = true
	}
	if mdPathRe.Test(filePath) {
		set["prose"] = true
	}
	return set
}

type directive struct {
	ruleID  string
	line    int
	endLine int
}

func findDisableDirectives(lines []string) []directive {
	var directives []directive
	var open *directive
	for i, line := range lines {
		if !strings.Contains(line, "no-slop-") {
			continue
		}
		if m := nextLineDirRe.Find(line); m != nil {
			g, _ := m.Group(1)
			directives = append(directives, directive{jsTrim(g), i + 2, i + 2})
			continue
		}
		if m := disableDirRe.Find(line); m != nil {
			g, _ := m.Group(1)
			open = &directive{ruleID: jsTrim(g), line: i + 1}
			continue
		}
		if open != nil && enableDirRe.Test(line) {
			open.endLine = i + 1
			directives = append(directives, *open)
			open = nil
		}
	}
	if open != nil {
		open.endLine = len(lines)
		directives = append(directives, *open)
	}
	return directives
}

func isSuppressed(directives []directive, ruleID string, line int) bool {
	for _, d := range directives {
		if (d.ruleID == "*" || d.ruleID == ruleID) && line >= d.line && line <= d.endLine {
			return true
		}
	}
	return false
}

func langOf(filePath string) string {
	ext := pathExtname(filePath)
	if ext == "" {
		return "unknown"
	}
	return ext[1:]
}

// scanFile reads filePath; config nil means load it from the file's directory.
func (a *app) scanFile(filePath string, config Config, extraClasses map[string]bool) []Finding {
	text := mustReadText(filePath)
	classes := extraClasses
	if classes == nil {
		classes = classesFor(filePath)
	}
	if config == nil {
		config = loadConfig(pathDirname(filePath))
	}
	findings := a.scan(text, langOf(filePath), classes, config)
	directives := findDisableDirectives(strings.Split(text, "\n"))
	if len(directives) == 0 {
		return findings
	}
	var kept []Finding
	for _, f := range findings {
		if !isSuppressed(directives, f.RuleID, f.Line) {
			kept = append(kept, f)
		}
	}
	return kept
}

func walk(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		p := pathJoin(dir, name)
		if strings.HasPrefix(name, ".") && name != "." {
			continue
		}
		if isExcluded(p) {
			continue
		}
		if e.IsDir() {
			out = append(out, walk(p)...)
		} else if scannableRe.Test(name) {
			out = append(out, p)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// reporting

func render(findings []Finding, file string) string {
	blocks := make([]string, len(findings))
	for i, f := range findings {
		loc := "line "
		if file != "" {
			loc = file + ":"
		}
		excerpt := f.Excerpt
		if jsLen(excerpt) > 110 {
			excerpt = jsSlice(excerpt, 0, 107) + "..."
		}
		blocks[i] = strings.Join([]string{
			fmt.Sprintf("  [%s] %s%d  %s", strings.ToUpper(f.Severity), loc, f.Line, f.RuleID),
			"      " + f.Message,
			"      > " + excerpt,
			"      fix: " + f.Fix,
		}, "\n")
	}
	return strings.Join(blocks, "\n")
}

// capped keeps every BLOCK and at most cap WARNs, ordered by line.
func capped(findings []Finding, cap int) (shown []Finding, hidden int) {
	var warns []Finding
	for _, f := range findings {
		if f.Severity == "block" {
			shown = append(shown, f)
		} else if f.Severity == "warn" {
			warns = append(warns, f)
		}
	}
	if len(warns) > cap {
		hidden = len(warns) - cap
		warns = warns[:cap]
	}
	shown = append(shown, warns...)
	sort.SliceStable(shown, func(i, j int) bool { return shown[i].Line < shown[j].Line })
	return shown, hidden
}

// ---------------------------------------------------------------------------
// commit message extraction

type shellToken struct{ raw, value string }

func tokenize(s string) []shellToken {
	var out []shellToken
	var raw, value []rune
	var quote rune
	push := func() {
		if len(raw) > 0 || len(value) > 0 {
			out = append(out, shellToken{fromUnits(raw), fromUnits(value)})
		}
		raw, value = nil, nil
	}
	units := utf16Units(s)
	for i := 0; i < len(units); i++ {
		c := units[i]
		if quote != 0 {
			if c == quote {
				quote = 0
				raw = append(raw, c)
				continue
			}
			if c == '\\' && quote == '"' && i+1 < len(units) {
				i++
				value = append(value, units[i])
				raw = append(raw, c)
				continue
			}
			value = append(value, c)
			raw = append(raw, c)
			continue
		}
		if c == '"' || c == '\'' {
			quote = c
			raw = append(raw, c)
			continue
		}
		if isJSSpace(c) {
			push()
			continue
		}
		value = append(value, c)
		raw = append(raw, c)
	}
	push()
	return out
}

// commitMessage is the message a `git commit` command will use; ok is false when it is not visible on the command line.
func commitMessage(command string) (message string, ok bool) {
	if !commitGateRe.Test(command) {
		return "", false
	}
	tail := jsSlice(command, commitWordRe.Find(command).Index, sliceToEnd)
	if opaqueFlagRe.Test(tail) {
		return "", false
	}
	if m := heredocRe.Find(command); m != nil {
		body, found := m.Group(3)
		if !found {
			body, _ = m.Group(6)
		}
		return jsTrimEnd(body), true
	}
	var messages []string
	tokens := tokenize(command)
	for i := 0; i < len(tokens); i++ {
		t := tokens[i]
		switch {
		case t.raw == "-m" || t.raw == "--message":
			if i+1 < len(tokens) {
				i++
				messages = append(messages, tokens[i].value)
			}
		case strings.HasPrefix(t.raw, "--message="):
			messages = append(messages, jsSlice(t.value, len("--message="), sliceToEnd))
		case shortMessageRe.Test(t.raw) && i+1 < len(tokens):
			i++
			messages = append(messages, tokens[i].value)
		}
	}
	if len(messages) == 0 {
		return "", false
	}
	return strings.Join(messages, "\n\n"), true
}

// renderTerse is the one-line-per-finding form for hook output an agent reads.
func renderTerse(findings []Finding, file string) string {
	lines := make([]string, len(findings))
	for i, f := range findings {
		lines[i] = fmt.Sprintf("%s:%d %s (%s)", file, f.Line, f.RuleID, f.Severity)
	}
	return strings.Join(lines, "\n")
}
