package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// JSON.parse / JSON.stringify as V8 does them: object keys keep JS order,
// parse errors carry V8's wording, strings are UTF-16 aware.

type jkind int

const (
	jNull jkind = iota
	jBool
	jNum
	jStr
	jArr
	jObj
)

type jval struct {
	kind jkind
	b    bool
	n    float64
	s    string
	arr  []*jval
	keys []string
	obj  map[string]*jval
}

func newObject() *jval { return &jval{kind: jObj, obj: map[string]*jval{}} }

func (o *jval) set(key string, v *jval) {
	if _, dup := o.obj[key]; !dup {
		o.keys = append(o.keys, key)
	}
	o.obj[key] = v
}

func isArrayIndexKey(k string) (uint64, bool) {
	if k == "" || (len(k) > 1 && k[0] == '0') || len(k) > 10 {
		return 0, false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return n, err == nil && n < 4294967295
}

// orderedKeys is own-property order: integer-like keys ascending, then insertion order.
func (o *jval) orderedKeys() []string {
	var idx, rest []string
	for _, k := range o.keys {
		if _, ok := isArrayIndexKey(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(a, b int) bool {
		x, _ := isArrayIndexKey(idx[a])
		y, _ := isArrayIndexKey(idx[b])
		return x < y
	})
	return append(idx, rest...)
}

type jentry struct {
	key string
	val *jval
}

// entries is Object.entries for an object or array value.
func (v *jval) entries() []jentry {
	switch v.kind {
	case jObj:
		var out []jentry
		for _, k := range v.orderedKeys() {
			out = append(out, jentry{k, v.obj[k]})
		}
		return out
	case jArr:
		var out []jentry
		for i, e := range v.arr {
			out = append(out, jentry{strconv.Itoa(i), e})
		}
		return out
	}
	return nil
}

// member is v[key] for an object, nil otherwise (undefined).
func (v *jval) member(key string) *jval {
	if v != nil && v.kind == jObj {
		return v.obj[key]
	}
	return nil
}

// toString is String(value) as a template literal sees it.
func (v *jval) toString() string {
	switch v.kind {
	case jNull:
		return "null"
	case jBool:
		return strconv.FormatBool(v.b)
	case jNum:
		return jsNumberString(v.n)
	case jStr:
		return v.s
	case jArr:
		parts := make([]string, len(v.arr))
		for i, e := range v.arr {
			if e.kind != jNull {
				parts[i] = e.toString()
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// truthy is JS ToBoolean.
func (v *jval) truthy() bool {
	switch v.kind {
	case jNull:
		return false
	case jBool:
		return v.b
	case jNum:
		return v.n != 0 && !math.IsNaN(v.n)
	case jStr:
		return v.s != ""
	}
	return true
}

// ---------------------------------------------------------------------------
// parse

type jsonSyntaxError struct{ msg string }

func (e *jsonSyntaxError) Error() string { return e.msg }

type jsonParser struct {
	t     []rune
	pos   int
	depth int
}

func parseJSON(text string) (v *jval, err error) {
	p := &jsonParser{t: utf16Units(text)}
	defer func() {
		if r := recover(); r != nil {
			se, ok := r.(*jsonSyntaxError)
			if !ok {
				panic(r)
			}
			v, err = nil, se
		}
	}()
	p.ws()
	v = p.value()
	p.ws()
	if p.pos < len(p.t) {
		p.failAt("Unexpected non-whitespace character after JSON", p.pos)
	}
	return v, nil
}

func (p *jsonParser) lineCol(pos int) (int, int) {
	line, start := 1, 0
	for i := 0; i < pos && i < len(p.t); i++ {
		switch p.t[i] {
		case '\r':
			if i+1 < len(p.t) && p.t[i+1] == '\n' {
				i++
			}
			line++
			start = i + 1
		case '\n':
			line++
			start = i + 1
		}
	}
	return line, pos - start + 1
}

func (p *jsonParser) failAt(what string, pos int) {
	line, col := p.lineCol(pos)
	join := " in JSON at"
	if strings.HasSuffix(what, "after JSON") {
		join = " at"
	}
	panic(&jsonSyntaxError{fmt.Sprintf("%s%s position %d (line %d column %d)", what, join, pos, line, col)})
}

func (p *jsonParser) unexpected(pos int) {
	if pos >= len(p.t) {
		panic(&jsonSyntaxError{"Unexpected end of JSON input"})
	}
	c := p.t[pos]
	switch {
	case c == '"':
		p.failAt("Unexpected string", pos)
	case c == '-' || (c >= '0' && c <= '9'):
		p.failAt("Unexpected number", pos)
	}
	src := fromUnits(p.t)
	if src == "undefined" || src == "NaN" || src == "Infinity" || src == "[object Object]" {
		panic(&jsonSyntaxError{fmt.Sprintf("%q is not valid JSON", src)})
	}
	tok := fromUnits([]rune{c})
	n := len(p.t)
	const ctx = 10
	var msg string
	switch {
	case n < 2*ctx+1:
		msg = fmt.Sprintf("Unexpected token '%s', \"%s\" is not valid JSON", tok, src)
	case pos < ctx:
		msg = fmt.Sprintf("Unexpected token '%s', \"%s\"... is not valid JSON", tok, fromUnits(p.t[:pos+ctx]))
	case pos < n-ctx:
		msg = fmt.Sprintf("Unexpected token '%s', ...\"%s\"... is not valid JSON", tok, fromUnits(p.t[pos-ctx:pos+ctx]))
	default:
		msg = fmt.Sprintf("Unexpected token '%s', ...\"%s\" is not valid JSON", tok, fromUnits(p.t[pos-ctx:]))
	}
	panic(&jsonSyntaxError{msg})
}

func (p *jsonParser) ws() {
	for p.pos < len(p.t) {
		switch p.t[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) at(c rune) bool { return p.pos < len(p.t) && p.t[p.pos] == c }

func (p *jsonParser) value() *jval {
	if p.pos >= len(p.t) {
		p.unexpected(p.pos)
	}
	c := p.t[p.pos]
	switch {
	case c == '"':
		return &jval{kind: jStr, s: p.str()}
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == '{' || c == '[':
		p.depth++
		if p.depth > maxJSONDepth {
			panic(&jsonSyntaxError{"Maximum JSON nesting depth exceeded"})
		}
		defer func() { p.depth-- }()
		if c == '{' {
			return p.object()
		}
		return p.array()
	case c == 't':
		p.literal("true")
		return &jval{kind: jBool, b: true}
	case c == 'f':
		p.literal("false")
		return &jval{kind: jBool}
	case c == 'n':
		p.literal("null")
		return &jval{kind: jNull}
	}
	p.unexpected(p.pos)
	return nil
}

func (p *jsonParser) literal(word string) {
	for _, w := range word {
		if p.pos >= len(p.t) || p.t[p.pos] != w {
			p.unexpected(p.pos)
		}
		p.pos++
	}
}

func isDigit(c rune) bool { return c >= '0' && c <= '9' }

func (p *jsonParser) digits() {
	for p.pos < len(p.t) && isDigit(p.t[p.pos]) {
		p.pos++
	}
}

func (p *jsonParser) number() *jval {
	start := p.pos
	if p.at('-') {
		p.pos++
		if p.pos >= len(p.t) || !isDigit(p.t[p.pos]) {
			p.failAt("No number after minus sign", p.pos)
		}
	}
	if p.at('0') {
		p.pos++
		if p.pos < len(p.t) && isDigit(p.t[p.pos]) {
			p.failAt("Unexpected number", p.pos)
		}
	} else {
		p.digits()
	}
	if p.at('.') {
		p.pos++
		if p.pos >= len(p.t) || !isDigit(p.t[p.pos]) {
			p.failAt("Unterminated fractional number", p.pos)
		}
		p.digits()
	}
	if p.at('e') || p.at('E') {
		p.pos++
		if p.at('+') || p.at('-') {
			p.pos++
		}
		if p.pos >= len(p.t) || !isDigit(p.t[p.pos]) {
			p.failAt("Exponent part is missing a number", p.pos)
		}
		p.digits()
	}
	f, _ := strconv.ParseFloat(string(p.t[start:p.pos]), 64)
	return &jval{kind: jNum, n: f}
}

func hexVal(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (p *jsonParser) str() string {
	p.pos++
	var out []rune
	for {
		if p.pos >= len(p.t) {
			p.failAt("Unterminated string", p.pos)
		}
		c := p.t[p.pos]
		switch {
		case c == '"':
			p.pos++
			return fromUnits(out)
		case c < 0x20:
			p.failAt("Bad control character in string literal", p.pos)
		case c == '\\':
			p.pos++
			if p.pos >= len(p.t) {
				p.unexpected(p.pos)
			}
			e := p.t[p.pos]
			switch e {
			case '"', '\\', '/':
				out = append(out, e)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				code := 0
				for i := 1; i <= 4; i++ {
					if p.pos+i >= len(p.t) || hexVal(p.t[p.pos+i]) < 0 {
						p.failAt("Bad Unicode escape", p.pos+i)
					}
					code = code<<4 | hexVal(p.t[p.pos+i])
				}
				p.pos += 4
				out = append(out, rune(code))
			default:
				p.failAt("Bad escaped character", p.pos)
			}
			p.pos++
		default:
			out = append(out, c)
			p.pos++
		}
	}
}

func (p *jsonParser) object() *jval {
	obj := newObject()
	p.pos++
	p.ws()
	if p.at('}') {
		p.pos++
		return obj
	}
	if !p.at('"') {
		p.failAt("Expected property name or '}'", p.pos)
	}
	for {
		key := p.str()
		p.ws()
		if !p.at(':') {
			p.failAt("Expected ':' after property name", p.pos)
		}
		p.pos++
		p.ws()
		obj.set(key, p.value())
		p.ws()
		switch {
		case p.at(','):
			p.pos++
			p.ws()
			if !p.at('"') {
				p.failAt("Expected double-quoted property name", p.pos)
			}
		case p.at('}'):
			p.pos++
			return obj
		default:
			p.failAt("Expected ',' or '}' after property value", p.pos)
		}
	}
}

func (p *jsonParser) array() *jval {
	arr := &jval{kind: jArr}
	p.pos++
	p.ws()
	if p.at(']') {
		p.pos++
		return arr
	}
	for {
		arr.arr = append(arr.arr, p.value())
		p.ws()
		switch {
		case p.at(','):
			p.pos++
			p.ws()
		case p.at(']'):
			p.pos++
			return arr
		default:
			p.failAt("Expected ',' or ']' after array element", p.pos)
		}
	}
}

// ---------------------------------------------------------------------------
// stringify

func jsonQuote(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// jsonStringify is JSON.stringify(v, null, indent) for a defined value;
// indent "" means compact.
func jsonStringify(v *jval, indent string) string {
	var sb strings.Builder
	writeJSON(&sb, v, indent, "")
	return sb.String()
}

func writeJSON(sb *strings.Builder, v *jval, indent, cur string) {
	switch v.kind {
	case jNull:
		sb.WriteString("null")
	case jBool:
		sb.WriteString(strconv.FormatBool(v.b))
	case jNum:
		if math.IsInf(v.n, 0) || math.IsNaN(v.n) {
			sb.WriteString("null")
		} else {
			sb.WriteString(jsNumberString(v.n))
		}
	case jStr:
		sb.WriteString(jsonQuote(v.s))
	case jArr:
		writeJSONList(sb, len(v.arr), indent, cur, '[', ']', func(i int, inner string) {
			writeJSON(sb, v.arr[i], indent, inner)
		})
	case jObj:
		keys := v.orderedKeys()
		writeJSONList(sb, len(keys), indent, cur, '{', '}', func(i int, inner string) {
			sb.WriteString(jsonQuote(keys[i]))
			sb.WriteByte(':')
			if indent != "" {
				sb.WriteByte(' ')
			}
			writeJSON(sb, v.obj[keys[i]], indent, inner)
		})
	}
}

func writeJSONList(sb *strings.Builder, n int, indent, cur string, open, close byte, item func(i int, inner string)) {
	sb.WriteByte(open)
	if n == 0 {
		sb.WriteByte(close)
		return
	}
	inner := cur + indent
	for i := 0; i < n; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		if indent != "" {
			sb.WriteByte('\n')
			sb.WriteString(inner)
		}
		item(i, inner)
	}
	if indent != "" {
		sb.WriteByte('\n')
		sb.WriteString(cur)
	}
	sb.WriteByte(close)
}

// maxJSONDepth bounds recursion; deeper input is treated as malformed (Node tolerates it but no real payload nests this deep).
const maxJSONDepth = 10000
