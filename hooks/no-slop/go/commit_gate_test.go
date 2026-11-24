package main

import "testing"

// Both ports must agree on these; hook.test.mjs carries the same table.
func TestCommitMessageVisibleForms(t *testing.T) {
	cases := []struct {
		name    string
		command string
		want    string
		visible bool
	}{
		{"stuck -m with double quotes", `git commit -m"Add cutting-edge parser"`, "Add cutting-edge parser", true},
		{"stuck -m with single quotes", `git commit -m'Add cutting-edge parser'`, "Add cutting-edge parser", true},
		{"stuck -am", `git commit -am"Add cutting-edge parser"`, "Add cutting-edge parser", true},
		{"stuck -m after a spaced -m", `git commit -m "sub" -m"body"`, "sub\n\nbody", true},
		{"unquoted word starting with -m is not a message", `git commit -m "x" && find . -maxdepth 1`, "x", true},
		{"-F - fed by a heredoc", "git commit -F - <<'EOF'\nAdd cutting-edge parser\nEOF", "Add cutting-edge parser", true},
		{"--file=- fed by a heredoc", "git commit --file=- <<EOF\nAdd cutting-edge parser\nEOF", "Add cutting-edge parser", true},
		{"--file - fed by a heredoc", "git commit --file - <<EOF\nAdd cutting-edge parser\nEOF", "Add cutting-edge parser", true},
		{"-F - without a heredoc stays opaque", "git commit -F -", "", false},
		{"-F file stays opaque even with a heredoc elsewhere", "git commit -F msg.txt <<EOF\nx\nEOF", "", false},
		{"-F - plus another opaque flag stays opaque", "git commit -F - --template t <<EOF\nx\nEOF", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := commitMessage(c.command)
			if ok != c.visible || got != c.want {
				t.Fatalf("commitMessage(%q) = %q, %v; want %q, %v", c.command, got, ok, c.want, c.visible)
			}
		})
	}
}

func TestCommitModeBlocksStuckAndStdinForms(t *testing.T) {
	r := newRepo(t)
	for _, c := range []string{
		`git commit -m"Add cutting-edge parser"`,
		"git commit -F - <<'EOF'\nAdd cutting-edge parser\nEOF",
	} {
		if res := r.run(commitPayload(t, c), "commit"); res.code != 2 {
			t.Errorf("%q must block, got %+v", c, res)
		}
	}
}
