package main

// __dump is the harness entry point: it reads a JSON array of inputs on stdin and prints the findings as JSON, with the budget off so output is deterministic, unless the second argument is --budget.

func jstr(s string) *jval { return &jval{kind: jStr, s: s} }

func findingsJSON(findings []Finding) *jval {
	list := &jval{kind: jArr}
	for _, f := range findings {
		o := newObject()
		o.set("ruleId", jstr(f.RuleID))
		o.set("severity", jstr(f.Severity))
		o.set("line", &jval{kind: jNum, n: float64(f.Line)})
		o.set("excerpt", jstr(f.Excerpt))
		o.set("message", jstr(f.Message))
		o.set("fix", jstr(f.Fix))
		list.arr = append(list.arr, o)
	}
	return list
}

func (a *app) dumpItem(kind, input string) *jval {
	result := newObject()
	var findings []Finding
	switch kind {
	case "files":
		fresh := applyBaseline(a.scanFile(input, nil, nil), findBaseline(pathDirname(input)), pathResolve(input))
		findings = fresh
	case "proseFile":
		findings = applyBaseline(a.scanFile(input, nil, map[string]bool{"prose": true}), findBaseline(pathDirname(input)), pathResolve(input))
	case "message":
		findings = a.scan(input, "unknown", map[string]bool{"commit": true}, loadConfig(processCwd()))
	case "prose":
		findings = a.scan(input, "unknown", map[string]bool{"prose": true}, loadConfig(processCwd()))
	case "command":
		message, visible := commitMessage(input)
		if !visible || jsTrim(message) == "" {
			result.set("message", &jval{kind: jNull})
		} else {
			result.set("message", jstr(message))
			findings = a.scan(message, "unknown", map[string]bool{"commit": true}, loadConfig(processCwd()))
		}
	case "walk":
		files := &jval{kind: jArr}
		for _, p := range walk(input) {
			files.arr = append(files.arr, jstr(p))
		}
		result.set("files", files)
		return result
	default:
		die("unknown dump kind %q", kind)
	}
	result.set("findings", findingsJSON(findings))
	return result
}

func (a *app) modeDump(args []string) int {
	if len(args) == 0 {
		die("__dump needs a kind")
	}
	a.unbudgeted = len(args) < 2 || args[1] != "--budget"
	inputs, err := parseJSON(a.readStdin())
	if err != nil || inputs.kind != jArr {
		die("__dump expects a JSON array on stdin")
	}
	out := &jval{kind: jArr}
	for _, in := range inputs.arr {
		out.arr = append(out.arr, a.dumpItem(args[0], in.s))
	}
	a.printf("%s\n", jsonStringify(out, ""))
	return 0
}
