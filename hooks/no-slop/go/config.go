package main

import (
	"fmt"
	"math"
	"strings"
)

type configEntry struct {
	severity    string
	hasSeverity bool
	opts        map[string]float64
}

// Config is a validated, normalised rule config; severity is omitted rather than empty when absent.
type Config map[string]configEntry

type unknownRuleError struct{ msg string }

func (e *unknownRuleError) Error() string { return e.msg }

// Object.prototype member names: `k in {}` is true for these, so they pass the option-name check.
var objectPrototypeKeys = map[string]bool{
	"constructor": true, "hasOwnProperty": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toLocaleString": true, "toString": true, "valueOf": true, "__proto__": true,
	"__defineGetter__": true, "__defineSetter__": true, "__lookupGetter__": true, "__lookupSetter__": true,
}

func isAllowedOption(id, key string) bool {
	if objectPrototypeKeys[key] {
		return true
	}
	for _, name := range ruleOptionNames[id] {
		if name == key {
			return true
		}
	}
	return false
}

func ruleIDList() string {
	ids := make([]string, len(rules))
	for i, r := range rules {
		ids[i] = r.id
	}
	return strings.Join(ids, ", ")
}

func normalizeEntry(id string, value *jval, source string) (configEntry, error) {
	entry := configEntry{}
	var severity *jval
	var optEntries []jentry
	switch value.kind {
	case jStr:
		severity = value
	case jObj:
		for _, e := range value.entries() {
			if e.key == "severity" {
				severity = e.val
			} else {
				optEntries = append(optEntries, e)
			}
		}
	}
	if severity != nil {
		if severity.kind != jStr || (severity.s != "off" && severity.s != "warn" && severity.s != "block") {
			return entry, &unknownRuleError{fmt.Sprintf(`%s: rule "%s" has level "%s"; expected "off", "warn" or "block".`, source, id, severity.toString())}
		}
		entry.severity, entry.hasSeverity = severity.s, true
	}
	for _, e := range optEntries {
		if !isAllowedOption(id, e.key) {
			tail := "It takes no options."
			if known := ruleOptionNames[id]; len(known) > 0 {
				tail = "Known options: " + strings.Join(known, ", ") + "."
			}
			return entry, &unknownRuleError{fmt.Sprintf(`%s: rule "%s" has no option "%s". %s`, source, id, e.key, tail)}
		}
		v := e.val
		if v.kind != jNum || v.n != math.Trunc(v.n) || math.IsInf(v.n, 0) || v.n < 1 {
			return entry, &unknownRuleError{fmt.Sprintf(`%s: rule "%s" option "%s" must be a positive integer (got %s).`, source, id, e.key, jsonStringify(v, ""))}
		}
		if entry.opts == nil {
			entry.opts = map[string]float64{}
		}
		entry.opts[e.key] = v.n
	}
	return entry, nil
}

// validateConfig throws (returns an error) on an unknown ruleId, bad severity, or unknown option.
func validateConfig(config *jval, source string) (Config, error) {
	out := Config{}
	if config == nil {
		return out, nil
	}
	for _, e := range config.entries() {
		if ruleByID[e.key] == nil {
			return nil, &unknownRuleError{fmt.Sprintf(`%s: unknown rule id "%s". Known ids: %s`, source, e.key, ruleIDList())}
		}
		if e.val.kind == jArr {
			return nil, &unknownRuleError{fmt.Sprintf(`%s: rule "%s" must be a severity string or an options object, not an array.`, source, e.key)}
		}
		entry, err := normalizeEntry(e.key, e.val, source)
		if err != nil {
			return nil, err
		}
		out[e.key] = entry
	}
	return out, nil
}

// mergeConfig is {...dst[id], ...src[id]} per rule id.
func mergeConfig(dst, src Config) {
	for id, entry := range src {
		merged := dst[id]
		if entry.hasSeverity {
			merged.severity, merged.hasSeverity = entry.severity, true
		}
		if len(entry.opts) > 0 {
			opts := map[string]float64{}
			for k, v := range merged.opts {
				opts[k] = v
			}
			for k, v := range entry.opts {
				opts[k] = v
			}
			merged.opts = opts
		}
		dst[id] = merged
	}
}

// ruleOptions: repo overrides on top of the built-in defaults.
func ruleOptions(id string, config Config) map[string]float64 {
	out := map[string]float64{}
	for k, v := range ruleOptionDefaults[id] {
		out[k] = v
	}
	for k, v := range config[id].opts {
		out[k] = v
	}
	return out
}
