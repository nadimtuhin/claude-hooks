package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// A runtime stack overflow is fatal and exits 2, which would block every Bash call; node exits 0 on the same payload.
func TestDeeplyNestedPayloadDoesNotCrashTheProcess(t *testing.T) {
	if os.Getenv("NO_SLOP_DEEP_CHILD") == "1" {
		payload := `{"tool_input":{"command":"git commit -m wip","x":` + strings.Repeat("[", 8_000_000)
		os.Exit(run([]string{"commit"}, strings.NewReader(payload), &bytes.Buffer{}, &bytes.Buffer{}))
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestDeeplyNestedPayloadDoesNotCrashTheProcess$")
	cmd.Env = append(os.Environ(), "NO_SLOP_DEEP_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child did not exit 0: %v\n%.300s", err, out)
	}
}

func TestJSONNestingCap(t *testing.T) {
	nested := func(n int) string { return strings.Repeat("[", n) + strings.Repeat("]", n) }
	if _, err := parseJSON(nested(maxJSONDepth)); err != nil {
		t.Fatalf("depth %d must parse: %v", maxJSONDepth, err)
	}
	if _, err := parseJSON(nested(maxJSONDepth + 1)); err == nil {
		t.Fatalf("depth %d must be rejected as malformed", maxJSONDepth+1)
	}
	deepObject := strings.Repeat(`{"a":`, maxJSONDepth+1) + "1" + strings.Repeat("}", maxJSONDepth+1)
	if _, err := parseJSON(deepObject); err == nil {
		t.Fatal("deep objects must be rejected too")
	}
}
