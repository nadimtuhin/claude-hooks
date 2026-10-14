package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// testPanicHook lets tests prove that a crash inside run() exits 1, never 2 (which would block every Bash call).
var testPanicHook func()

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) (code int) {
	a := &app{stdin: stdin, out: &bytes.Buffer{}, err: &bytes.Buffer{}}
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(a.err, "no-slop: %v\n", r)
			code = 1
		}
		stdout.Write(a.out.Bytes())
		stderr.Write(a.err.Bytes())
	}()
	if testPanicHook != nil {
		testPanicHook()
	}
	return a.dispatch(args)
}

func (a *app) dispatch(args []string) int {
	if len(args) == 0 {
		a.printf("%s", usageText)
		return 0
	}
	mode, rest := args[0], args[1:]
	switch mode {
	case "write":
		return a.modeWrite()
	case "commit":
		return a.modeCommit()
	case "turn":
		return a.modeTurn()
	case "scan":
		return a.modeScan(rest)
	case "baseline":
		return a.modeBaseline(rest)
	case "__dump":
		return a.modeDump(rest)
	case "--help", "-h":
		a.printf("%s", usageText)
		return 0
	}
	a.eprintf("no-slop: unknown mode \"%s\"\n\n%s", mode, usageText)
	return 1
}

// physicalCwd matches Node's process.cwd(), which is the symlink-resolved path.
func physicalCwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "/"
	}
	if real, err := filepath.EvalSymlinks(wd); err == nil {
		return real
	}
	return wd
}

func stdinIsTerminal() bool {
	info, err := os.Stdin.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	null, err := os.Stat(os.DevNull)
	return err != nil || !os.SameFile(info, null)
}

func main() {
	cwd := physicalCwd()
	processCwd = func() string { return cwd }
	var stdin io.Reader
	if !stdinIsTerminal() {
		stdin = os.Stdin
	}
	os.Exit(run(os.Args[1:], stdin, os.Stdout, os.Stderr))
}
