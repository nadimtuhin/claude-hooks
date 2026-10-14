package main

import "testing"

func TestEveryRegexCompiles(t *testing.T) {
	if len(jsRegistry) < 40 {
		t.Fatalf("expected the rule regexes to be registered, got %d", len(jsRegistry))
	}
	for _, r := range jsRegistry {
		if r.re == nil {
			t.Errorf("regex %q did not compile", r.src)
		}
	}
}

func TestWordBoundaryIsAsciiOnly(t *testing.T) {
	re := mustJS(`\bfoo\b`, false)
	cases := []struct {
		in   string
		want bool
	}{
		{"foo", true},
		{"éfoo", true},
		{"fooé", true},
		{"afoo", false},
		{"foo_", false},
		{"x foo y", true},
	}
	for _, c := range cases {
		if got := re.Test(c.in); got != c.want {
			t.Errorf("%q: got %v want %v", c.in, got, c.want)
		}
	}
	if !mustJS(`a\Bb`, false).Test("ab") || mustJS(`a\Bb`, false).Test("a b") {
		t.Error("\\B mistranslated")
	}
}

func TestDotExcludesAllLineTerminators(t *testing.T) {
	re := mustJS(`^a.b$`, false)
	for _, sep := range []string{"\n", "\r", " ", " "} {
		if re.Test("a" + sep + "b") {
			t.Errorf("dot matched %q", sep)
		}
	}
	if !re.Test("axb") || !re.Test("aéb") {
		t.Error("dot should match ordinary characters")
	}
}

func TestMatchOffsetsAreUTF16Units(t *testing.T) {
	m := mustJS(`x+`, false).Find("😀😀xx")
	if m == nil || m.Index != 4 || m.End != 6 {
		t.Fatalf("got %+v", m)
	}
	if m.Prefix() != "😀😀" {
		t.Errorf("prefix %q", m.Prefix())
	}
	if got := len(mustJS(`.`, false).FindAll("😀")); got != 2 {
		t.Errorf("non-unicode dot should see two units, got %d", got)
	}
}

func TestBackreferenceLookbehindAndBracketInClass(t *testing.T) {
	re := mustJS(`(?<![\w.$])([\w$][\w.$[\]]*)\s*===?\s*\1(?![\w.$])`, false)
	if !re.Test("expect(a[0] === a[0])") || re.Test("expect(m.id === id)") {
		t.Error("tautology backreference regex diverges")
	}
}

func TestUnmatchedGroupIsReported(t *testing.T) {
	m := mustJS(`a(b)?`, false).Find("ac")
	if _, ok := m.Group(1); ok {
		t.Error("group 1 should be undefined")
	}
}

func TestReplaceAll(t *testing.T) {
	if got := mustJS(`\d+`, false).ReplaceAll("a1b22c", "#"); got != "a#b#c" {
		t.Errorf("got %q", got)
	}
	if got := mustJS(`z`, false).ReplaceAll("abc", "#"); got != "abc" {
		t.Errorf("got %q", got)
	}
}
