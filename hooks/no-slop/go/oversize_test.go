package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDirectiveScanSkipsLinesWithoutTheMarker(t *testing.T) {
	lines := strings.Split(strings.Repeat("INSERT INTO t VALUES (1,'hello world',2,3);\n", 1_000_000), "\n")
	start := time.Now()
	found := findDisableDirectives(lines)
	elapsed := time.Since(start)
	if len(found) != 0 {
		t.Fatalf("found %d directives in marker-free lines", len(found))
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("directive scan of 1M plain lines took %v, want under 100ms", elapsed)
	}
}

func TestDirectivesStillFoundAmongPlainLines(t *testing.T) {
	lines := []string{"x", "// no-slop-disable-next-line naming-vague-generic", "y", "// no-slop-disable comment-density", "z", "// no-slop-enable comment-density", "w"}
	got := findDisableDirectives(lines)
	want := []directive{{"naming-vague-generic", 3, 3}, {"comment-density", 4, 6}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("directives = %+v, want %+v", got, want)
	}
}

func TestOversizedFileCanBeSuppressedOnLineOne(t *testing.T) {
	dir := t.TempDir()
	body := "// no-slop-disable file-too-large\n" + strings.Repeat("select 1;\n", 200_000)
	p := filepath.Join(dir, "big.sql")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{}
	if got := a.scanFile(p, Config{}, nil); len(got) != 0 {
		t.Fatalf("directive on line 1 should suppress file-too-large, got %+v", got)
	}
	plain := filepath.Join(dir, "plain.sql")
	if err := os.WriteFile(plain, []byte(strings.Repeat("select 1;\n", 200_000)), 0o644); err != nil {
		t.Fatal(err)
	}
	got := a.scanFile(plain, Config{}, nil)
	if len(got) != 1 || got[0].RuleID != "file-too-large" || got[0].Excerpt != "200001 lines" {
		t.Fatalf("got %+v, want one file-too-large finding with excerpt 200001 lines", got)
	}
}
