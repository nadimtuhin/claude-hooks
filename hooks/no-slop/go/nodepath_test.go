package main

import "testing"

type pathCase struct {
	Fn string `json:"fn"`
	A  string `json:"a"`
	B  string `json:"b"`
	R  string `json:"r"`
}

func TestNodePathMatchesNode(t *testing.T) {
	old := processCwd
	processCwd = func() string { return "/work/proj" }
	defer func() { processCwd = old }()
	for _, c := range readJSONL[pathCase](t, "testdata/path_cases.jsonl") {
		var got string
		switch c.Fn {
		case "dirname":
			got = pathDirname(c.A)
		case "basename":
			got = pathBasename(c.A)
		case "extname":
			got = pathExtname(c.A)
		case "normalize":
			got = pathNormalize(c.A)
		case "resolve":
			got = pathResolve("/work/proj", c.A)
		case "join":
			got = pathJoin(c.A, c.B)
		case "relative2":
			got = pathRelative(c.A, c.B)
		}
		if got != c.R {
			t.Errorf("%s(%q, %q) = %q, node says %q", c.Fn, c.A, c.B, got, c.R)
		}
	}
}
