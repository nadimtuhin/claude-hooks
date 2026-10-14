package main

import "testing"

func TestJSONParseMatchesV8(t *testing.T) {
	for _, c := range v8JSONCases {
		v, err := parseJSON(c.in)
		if c.errMsg != "" {
			if err == nil {
				t.Errorf("%q: expected error %q, parsed ok", c.in, c.errMsg)
			} else if err.Error() != c.errMsg {
				t.Errorf("%q:\n got  %q\n want %q", c.in, err.Error(), c.errMsg)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got := jsonStringify(v, ""); got != c.compact {
			t.Errorf("%q: stringify got %q want %q", c.in, got, c.compact)
		}
	}
}

func TestJSONStringifyIndentAndEscapes(t *testing.T) {
	o := newObject()
	o.set("b", &jval{kind: jStr, s: "\u2028\u2029\x7f\x01<&>\"\\/"})
	o.set("1", &jval{kind: jNum, n: 1})
	o.set("a", &jval{kind: jArr})
	o.set("e", newObject())
	want := "{\n  \"1\": 1,\n  \"b\": \"\u2028\u2029\x7f\\u0001<&>\\\"\\\\/\",\n  \"a\": [],\n  \"e\": {}\n}"
	if got := jsonStringify(o, "  "); got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestJSONNumbersFormatLikeJS(t *testing.T) {
	cases := map[float64]string{1e21: "1e+21", 1e-7: "1e-7", 123456789012345680000: "123456789012345680000", 0.1: "0.1", -1.5: "-1.5"}
	for in, want := range cases {
		if got := jsNumberString(in); got != want {
			t.Errorf("%v: got %q want %q", in, got, want)
		}
	}
}
