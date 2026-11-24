package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// countingReader yields n spaces and records how many bytes the hook pulled.
type countingReader struct{ left, read int }

func (r *countingReader) Read(p []byte) (int, error) {
	if r.left == 0 {
		return 0, io.EOF
	}
	n := min(len(p), r.left)
	for i := range p[:n] {
		p[i] = ' '
	}
	r.left -= n
	r.read += n
	return n, nil
}

func TestHookPayloadReadIsBounded(t *testing.T) {
	slop := `{"tool_input":{"command":"git commit -m \"Add cutting-edge parser\""}}`
	cases := []struct {
		name     string
		stdin    func() (io.Reader, *countingReader)
		wantCode int
	}{
		{"payload under the limit is parsed", func() (io.Reader, *countingReader) {
			return strings.NewReader(slop + strings.Repeat(" ", 1<<20)), nil
		}, 2},
		{"payload over the limit fails open without reading it all", func() (io.Reader, *countingReader) {
			pad := &countingReader{left: maxPayloadBytes * 3}
			return io.MultiReader(strings.NewReader(slop), pad), pad
		}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stdin, pad := c.stdin()
			var out, errOut bytes.Buffer
			if code := run([]string{"commit"}, stdin, &out, &errOut); code != c.wantCode {
				t.Fatalf("exit %d, want %d (stderr %q)", code, c.wantCode, errOut.String())
			}
			if pad != nil && pad.read > maxPayloadBytes {
				t.Fatalf("read %d padding bytes, want at most %d", pad.read, maxPayloadBytes)
			}
		})
	}
}
