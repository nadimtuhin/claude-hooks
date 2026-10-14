package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

func (a *app) printf(format string, args ...any)  { fmt.Fprintf(a.out, format, args...) }
func (a *app) eprintf(format string, args ...any) { fmt.Fprintf(a.err, format, args...) }

func (a *app) modeWrite() int {
	payload := a.readPayload()
	if payload.kind == jNull {
		typeErrorReading("tool_input")
	}
	input := payload.member("tool_input")
	fp := input.member("file_path")
	if nullish(fp) {
		fp = input.member("notebook_path")
	}
	if falsy(fp) || fp.kind != jStr || !exists(fp.s) {
		return 0
	}
	filePath := fp.s
	if isExcluded(filePath) || !scannableRe.Test(filePath) {
		return 0
	}

	findings := a.scanFile(filePath, nil, nil)
	fresh := applyBaseline(findings, findBaseline(pathDirname(filePath)), pathResolve(filePath))
	rel := filePath
	if root, ok := repoRoot(pathDirname(filePath)); ok {
		rel = pathRelative(root, filePath)
	}
	if len(fresh) == 0 {
		return 0
	}

	shown, hidden := capped(fresh, warnCap)
	a.eprintf("no-slop found %d issue(s) in %s:\n%s\n", len(fresh), rel, render(shown, rel))
	if hidden > 0 {
		a.eprintf("  +%d more warning(s) — see: no-slop scan %s --all\n", hidden, rel)
	}
	a.eprintf("These are style tripwires, not a build failure. Fix what is genuinely slop and move on.\n")
	return 2
}

func (a *app) modeCommit() int {
	payload := a.readPayload()
	if payload.kind == jNull {
		typeErrorReading("tool_input")
	}
	command := payload.member("tool_input").member("command")
	var message string
	var visible bool
	switch {
	case nullish(command):
	case command.kind == jStr:
		message, visible = commitMessage(command.s)
	case commitGateRe.Test(command.toString()):
		panic(hookError{"TypeError: command.search is not a function"})
	}
	if !visible || jsTrim(message) == "" {
		return 0
	}

	findings := a.scan(message, "unknown", map[string]bool{"commit": true}, loadConfig(processCwd()))
	if len(findings) == 0 {
		return 0
	}
	var blocks []Finding
	for _, f := range findings {
		if f.Severity == "block" {
			blocks = append(blocks, f)
		}
	}
	if len(blocks) > 0 {
		a.eprintf("no-slop: commit message\n%s\n", render(blocks, ""))
		return 2
	}
	a.printf("no-slop: commit message\n%s\n", render(findings, ""))
	return 0
}

// lastAssistantText walks the transcript JSONL backwards the way the Stop hook does; ok is false when the whole turn must be skipped.
func lastAssistantText(content string) (text string, ok bool) {
	lines := strings.Split(jsTrimEnd(content), "\n")
	for i := len(lines) - 1; i >= 0 && text == ""; i-- {
		entry, err := parseJSON(lines[i])
		if err != nil {
			return "", false
		}
		if role := entry.member("message").member("role"); role == nil || role.kind != jStr || role.s != "assistant" {
			continue
		}
		blocks := entry.member("message").member("content")
		if blocks == nil || blocks.kind != jArr {
			continue
		}
		for _, b := range blocks.arr {
			if b.kind == jNull {
				return "", false
			}
		}
		var parts []string
		for _, b := range blocks.arr {
			if t := b.member("type"); t == nil || t.kind != jStr || t.s != "text" {
				continue
			}
			if v := b.member("text"); nullish(v) {
				parts = append(parts, "")
			} else {
				parts = append(parts, v.toString())
			}
		}
		text = strings.Join(parts, "\n")
	}
	return text, true
}

func (a *app) modeTurn() int {
	payload := a.readPayload()
	if payload.kind == jNull {
		typeErrorReading("transcript_path")
	}
	tp := payload.member("transcript_path")
	if falsy(tp) || tp.kind != jStr || !exists(tp.s) {
		return 0
	}
	content, err := readText(tp.s)
	if err != nil {
		return 0
	}
	text, ok := lastAssistantText(content)
	if !ok || jsTrim(text) == "" {
		return 0
	}

	findings := a.scan(text, "unknown", map[string]bool{"prose": true}, loadConfig(processCwd()))
	if len(findings) == 0 {
		return 0
	}
	shown, hidden := capped(findings, warnCap)
	a.printf("no-slop (prose, advisory):\n%s\n", render(shown, ""))
	if hidden > 0 {
		a.printf("  +%d more\n", hidden)
	}
	return 0
}

func splitCommitStream(text string) []string {
	var messages []string
	start := 0
	flush := func(end, next int) {
		if m := jsTrim(text[start:end]); m != "" {
			messages = append(messages, m)
		}
		start = next
	}
	for i := 0; i < len(text); i++ {
		if text[i] != 0 && text[i] != 0x1e {
			continue
		}
		next := i + 1
		if next < len(text) && text[next] == '\n' {
			next++
		}
		flush(i, next)
		i = next - 1
	}
	flush(len(text), len(text))
	return messages
}

func (a *app) modeScan(argv []string) int {
	flags := map[string]bool{}
	var targets []string
	severityArg, hasSeverity := "", false
	for _, arg := range argv {
		if strings.HasPrefix(arg, "-") {
			flags[arg] = true
			if !hasSeverity && strings.HasPrefix(arg, "--severity=") {
				severityArg, hasSeverity = arg, true
			}
		} else {
			targets = append(targets, arg)
		}
	}
	minSeverity := "warn"
	if hasSeverity {
		minSeverity = strings.Split(severityArg, "=")[1]
	}
	if minSeverity != "warn" && minSeverity != "block" {
		die(`--severity must be "warn" or "block", got "%s"`, minSeverity)
	}

	total, reported := 0, 0
	emit := func(label string, findings []Finding) {
		var kept []Finding
		for _, f := range findings {
			if minSeverity != "block" || f.Severity == "block" {
				kept = append(kept, f)
			}
		}
		total += len(kept)
		if len(kept) == 0 {
			return
		}
		shown, hidden := kept, 0
		if !flags["--all"] {
			shown, hidden = capped(kept, warnCap)
		}
		reported += len(shown)
		a.printf("%s\n%s\n", label, render(shown, label))
		if hidden > 0 {
			a.printf("  +%d more (--all)\n", hidden)
		}
	}

	if flags["--stdin"] {
		a.scanStdin(flags, emit)
	} else {
		if len(targets) == 0 {
			die("scan needs a path, or --stdin")
		}
		for _, target := range targets {
			a.scanTarget(target, flags, emit)
		}
	}

	if total == 0 {
		a.printf("no-slop: clean\n")
		return 0
	}
	suffix := ""
	if reported < total {
		suffix = fmt.Sprintf(" (%d shown)", reported)
	}
	a.printf("no-slop: %d finding(s)%s\n", total, suffix)
	return 1
}

func (a *app) scanStdin(flags map[string]bool, emit func(string, []Finding)) {
	classes := map[string]bool{}
	for _, c := range ruleClasses {
		if flags["--"+c] {
			classes[c] = true
		}
	}
	if flags["--code"] {
		classes["comment"], classes["naming"] = true, true
	}
	if len(classes) == 0 {
		classes["comment"], classes["naming"] = true, true
	}
	text := a.readStdin()
	messages := []string{text}
	if classes["commit"] {
		if storedSepRe.Test(text) {
			messages = splitCommitStream(text)
		} else if strings.Contains(text, "\n") {
			a.eprintf("no-slop: no NUL separator found — treating stdin as a single message.\n")
			a.eprintf("no-slop: for per-commit results use: git log -300 --format=%%B%%x00\n")
		}
	}
	for i, m := range messages {
		label := "<stdin>"
		if classes["commit"] {
			label = fmt.Sprintf("<stdin> message %d", i+1)
		}
		emit(label, a.scan(m, "unknown", classes, Config{}))
	}
}

func statTarget(target string) (os.FileInfo, bool) {
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false
	}
	if err != nil {
		panic(hookError{"Error: " + fsMessage(err, "stat", target)})
	}
	return info, true
}

func (a *app) scanTarget(target string, flags map[string]bool, emit func(string, []Finding)) {
	info, found := statTarget(target)
	if !found {
		die("no such path: %s", target)
	}
	files := []string{target}
	baselineFrom := pathDirname(target)
	if info.IsDir() {
		files = walk(target)
		baselineFrom = target
	}
	var base *baseline
	if !flags["--no-baseline"] {
		base = findBaseline(baselineFrom)
	}
	var extra map[string]bool
	if flags["--prose"] {
		extra = map[string]bool{"prose": true}
	}
	configs := map[string]Config{}
	for _, file := range files {
		dir := pathDirname(file)
		if _, cached := configs[dir]; !cached {
			configs[dir] = loadConfig(dir)
		}
		findings := a.scanFile(file, configs[dir], extra)
		label := pathRelative(processCwd(), file)
		if label == "" {
			label = file
		}
		emit(label, applyBaseline(findings, base, pathResolve(file)))
	}
}

func (a *app) modeBaseline(argv []string) int {
	target := processCwd()
	for _, arg := range argv {
		if !strings.HasPrefix(arg, "-") {
			target = arg
			break
		}
	}
	info, found := statTarget(target)
	if !found {
		die("no such path: %s", target)
	}
	root, ok := repoRoot(target)
	if !ok {
		if info.IsDir() {
			root = pathResolve(target)
		} else {
			root = pathResolve(pathDirname(target))
		}
	}

	files := []string{target}
	if info.IsDir() {
		files = walk(target)
	}
	findings := newObject()
	count := 0
	configs := map[string]Config{}
	for _, file := range files {
		dir := pathDirname(file)
		if _, cached := configs[dir]; !cached {
			configs[dir] = loadConfig(dir)
		}
		existing := a.scanFile(file, configs[dir], nil)
		if len(existing) == 0 {
			continue
		}
		keys := &jval{kind: jArr}
		for _, f := range existing {
			keys.arr = append(keys.arr, &jval{kind: jStr, s: baselineKey(f)})
		}
		findings.set(pathRelative(root, file), keys)
		count += len(existing)
	}

	out := pathJoin(root, baselineFile)
	doc := newObject()
	doc.set("version", &jval{kind: jNum, n: 1})
	doc.set("findings", findings)
	if err := os.WriteFile(out, []byte(jsonStringify(doc, "  ")+"\n"), 0o666); err != nil {
		panic(hookError{"Error: " + fsMessage(err, "open", out)})
	}
	a.printf("no-slop: baselined %d existing finding(s) across %d file(s)\n", count, len(findings.keys))
	wrote := pathRelative(processCwd(), out)
	if wrote == "" {
		wrote = out
	}
	a.printf("no-slop: wrote %s — only NEW findings will be reported from here.\n", wrote)
	return 0
}
