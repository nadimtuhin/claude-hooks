package main

import (
	"strings"

	"github.com/dlclark/regexp2"
)

// Every ported JS regex goes through mustJS. Matching runs over UTF-16 code
// units (one rune per unit) so offsets, lengths and "." behave as in V8 without
// the /u flag. Known deviation: regexp2 /i folds U+212A (Kelvin) and U+017F to k and s,
// V8 non-unicode /i does not.

type jsRe struct {
	src string
	re  *regexp2.Regexp
}

var jsRegistry []*jsRe

type regexMatchError struct{ err error }

func (e regexMatchError) Error() string { return e.err.Error() }

func mustJS(pattern string, ignoreCase bool) *jsRe {
	var opts regexp2.RegexOptions = regexp2.ECMAScript
	if ignoreCase {
		opts |= regexp2.IgnoreCase
	}
	r := &jsRe{src: pattern, re: regexp2.MustCompile(translateJSPattern(pattern), opts)}
	jsRegistry = append(jsRegistry, r)
	return r
}

const (
	wordClass        = `[A-Za-z0-9_]`
	asciiWordBoundry = `(?:(?<=` + wordClass + `)(?!` + wordClass + `)|(?<!` + wordClass + `)(?=` + wordClass + `))`
	asciiNonBoundary = `(?:(?<=` + wordClass + `)(?=` + wordClass + `)|(?<!` + wordClass + `)(?!` + wordClass + `))`
	jsDot            = `[^\n\r\u2028\u2029]`
)

// regexp2's \b uses Unicode word characters and its "." admits U+2028/2029;
// V8 uses ASCII \w and excludes all four line terminators.
func translateJSPattern(p string) string {
	var sb strings.Builder
	inClass := false
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch {
		case c == '\\' && i+1 < len(p):
			next := p[i+1]
			i++
			switch {
			case !inClass && next == 'b':
				sb.WriteString(asciiWordBoundry)
			case !inClass && next == 'B':
				sb.WriteString(asciiNonBoundary)
			default:
				sb.WriteByte(c)
				sb.WriteByte(next)
			}
		case !inClass && c == '[':
			inClass = true
			sb.WriteByte(c)
		case inClass && c == ']':
			inClass = false
			sb.WriteByte(c)
		case !inClass && c == '.':
			sb.WriteString(jsDot)
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

type jsMatch struct {
	Index  int
	End    int
	units  []rune
	groups []string
	ok     []bool
}

func newMatch(m *regexp2.Match, units []rune) *jsMatch {
	gs := m.Groups()
	out := &jsMatch{units: units, groups: make([]string, len(gs)), ok: make([]bool, len(gs))}
	for i, g := range gs {
		if len(g.Captures) == 0 {
			continue
		}
		out.ok[i] = true
		out.groups[i] = fromUnits(units[g.Index : g.Index+g.Length])
		if i == 0 {
			out.Index = g.Index
			out.End = g.Index + g.Length
		}
	}
	return out
}

// Group returns capture i; the bool is false for an unmatched (undefined) group.
func (m *jsMatch) Group(i int) (string, bool) {
	if i >= len(m.groups) {
		return "", false
	}
	return m.groups[i], m.ok[i]
}

func (m *jsMatch) Str() string { return m.groups[0] }

// Prefix is input.slice(0, m.index).
func (m *jsMatch) Prefix() string { return fromUnits(m.units[:m.Index]) }

// Suffix is input.slice(m.index + m[0].length).
func (m *jsMatch) Suffix() string { return fromUnits(m.units[m.End:]) }

func mustMatch(m *regexp2.Match, err error) *regexp2.Match {
	if err != nil {
		panic(regexMatchError{err})
	}
	return m
}

func (r *jsRe) Find(s string) *jsMatch {
	units := utf16Units(s)
	m := mustMatch(r.re.FindRunesMatch(units))
	if m == nil {
		return nil
	}
	return newMatch(m, units)
}

func (r *jsRe) Test(s string) bool {
	ok, err := r.re.MatchRunes(utf16Units(s))
	if err != nil {
		panic(regexMatchError{err})
	}
	return ok
}

func (r *jsRe) FindAll(s string) []*jsMatch {
	units := utf16Units(s)
	var out []*jsMatch
	for m := mustMatch(r.re.FindRunesMatch(units)); m != nil; m = mustMatch(r.re.FindNextMatch(m)) {
		out = append(out, newMatch(m, units))
	}
	return out
}

// ReplaceAll is s.replace(/…/g, repl) with a literal replacement string.
func (r *jsRe) ReplaceAll(s, repl string) string {
	units := utf16Units(s)
	replUnits := utf16Units(repl)
	var out []rune
	last := 0
	for m := mustMatch(r.re.FindRunesMatch(units)); m != nil; m = mustMatch(r.re.FindNextMatch(m)) {
		g := m.Groups()[0]
		out = append(out, units[last:g.Index]...)
		out = append(out, replUnits...)
		last = g.Index + g.Length
	}
	if last == 0 && out == nil {
		return s
	}
	out = append(out, units[last:]...)
	return fromUnits(out)
}
