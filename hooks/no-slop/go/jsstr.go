package main

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// JS strings are UTF-16 code unit sequences. Go strings here are always valid
// UTF-8; every length, slice and regexp offset that JS would measure in code
// units goes through this file.

// decodeUTF8 mirrors Buffer.toString('utf8') (WHATWG decoder: one U+FFFD per
// maximal invalid subpart, BOM kept).
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b))
	var cp rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7F:
				sb.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x07)
			default:
				sb.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			cp, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			sb.WriteRune(utf8.RuneError)
			i--
			continue
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		if seen == needed {
			sb.WriteRune(cp)
			cp, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		sb.WriteRune(utf8.RuneError)
	}
	return sb.String()
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// lastUnits remembers the most recent short conversion: rules run many regexes over the same line back to back. Callers treat the slice as read-only.
var lastUnits struct {
	text  string
	units []rune
}

const maxCachedUnitsLen = 4096

// utf16Units returns s as UTF-16 code units, each held in a rune.
func utf16Units(s string) []rune {
	if len(s) > maxCachedUnitsLen {
		return convertToUnits(s)
	}
	if lastUnits.units != nil && lastUnits.text == s {
		return lastUnits.units
	}
	units := convertToUnits(s)
	lastUnits.text, lastUnits.units = s, units
	return units
}

func convertToUnits(s string) []rune {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		} else {
			out = append(out, r)
		}
	}
	return out
}

// fromUnits is the inverse; a lone surrogate becomes U+FFFD, which is what
// Node prints when it writes such a string to a stream.
func fromUnits(u []rune) string {
	var sb strings.Builder
	sb.Grow(len(u))
	for i := 0; i < len(u); i++ {
		r := u[i]
		switch {
		case r >= 0xD800 && r <= 0xDBFF && i+1 < len(u) && u[i+1] >= 0xDC00 && u[i+1] <= 0xDFFF:
			sb.WriteRune(0x10000 + (r-0xD800)<<10 + (u[i+1] - 0xDC00))
			i++
		case r >= 0xD800 && r <= 0xDFFF:
			sb.WriteRune(utf8.RuneError)
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// jsLen is JS String.prototype.length.
func jsLen(s string) int {
	if isASCII(s) {
		return len(s)
	}
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

const sliceToEnd = math.MaxInt

// jsSlice is String.prototype.slice(start, end) in UTF-16 units.
func jsSlice(s string, start, end int) string {
	if isASCII(s) {
		a, b := clampSlice(start, len(s)), clampSlice(end, len(s))
		if a >= b {
			return ""
		}
		return s[a:b]
	}
	u := utf16Units(s)
	a, b := clampSlice(start, len(u)), clampSlice(end, len(u))
	if a >= b {
		return ""
	}
	return fromUnits(u[a:b])
}

func clampSlice(i, n int) int {
	if i < 0 {
		i += n
		if i < 0 {
			return 0
		}
		return i
	}
	if i > n {
		return n
	}
	return i
}

// isJSSpace is ECMAScript WhiteSpace + LineTerminator, the set trim() and \s use.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string      { return strings.TrimFunc(s, isJSSpace) }
func jsTrimEnd(s string) string   { return strings.TrimRightFunc(s, isJSSpace) }
func jsTrimStart(s string) string { return strings.TrimLeftFunc(s, isJSSpace) }

// jsNumberString formats a float64 the way JS Number.prototype.toString does.
func jsNumberString(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	case v == 0:
		return "0"
	}
	abs := math.Abs(v)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(v, 'e', -1, 64)
		mant, exp, _ := strings.Cut(s, "e")
		sign := exp[0]
		digits := strings.TrimLeft(exp[1:], "0")
		return mant + "e" + string(sign) + digits
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}
