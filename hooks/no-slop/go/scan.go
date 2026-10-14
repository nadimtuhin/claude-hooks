package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

type Finding struct {
	RuleID   string
	Severity string
	Line     int
	Excerpt  string
	Message  string
	Fix      string
}

type ScanResult struct {
	Findings  []Finding
	Truncated int // 0 means not truncated
}

// ScanOptions mirrors scan(text, opts). BudgetMs of +Inf disables the wall-clock budget.
type ScanOptions struct {
	Lang     string
	Classes  map[string]bool
	Config   Config
	BudgetMs float64
	Now      func() float64
}

const defaultBudgetMs = 200

func wallClockMs() float64 { return float64(time.Now().UnixMilli()) }

func newScanOptions(lang string, classes map[string]bool, config Config) ScanOptions {
	return ScanOptions{Lang: lang, Classes: classes, Config: config, BudgetMs: defaultBudgetMs, Now: wallClockMs}
}

func noBudget(o ScanOptions) ScanOptions {
	o.BudgetMs = math.Inf(1)
	return o
}

type scanCtx struct {
	lang    string
	classes map[string]bool
	lines   []string
	options map[string]float64

	now      func() float64
	start    float64
	budgetMs float64
	// truncated is the 1-based line the budget cut at (0 = not truncated).
	truncated int
	lastLine  int

	bodies     []testBody
	bodiesDone bool

	declared map[int]declaredLine
	comments map[string]commentResult
}

// eachCodeLine is ctx.codeLines(): budget check on every line, long lines skipped.
type commentResult struct {
	text string
	ok   bool
}

// commentOf memoizes commentText: a pure function of the line that most rules ask about.
func (c *scanCtx) commentOf(line string) (string, bool) {
	if r, hit := c.comments[line]; hit {
		return r.text, r.ok
	}
	if c.comments == nil {
		c.comments = map[string]commentResult{}
	}
	text, ok := commentText(line, c.lang)
	c.comments[line] = commentResult{text, ok}
	return text, ok
}

func (c *scanCtx) eachCodeLine(fn func(n int, text string)) {
	for i := 0; i < len(c.lines); i++ {
		if c.now()-c.start > c.budgetMs {
			c.truncated = i + 1
			c.lastLine = i
			return
		}
		text := c.lines[i]
		if jsLen(text) > maxLineLen {
			continue
		}
		fn(i+1, text)
	}
}

func (c *scanCtx) testBodies() []testBody {
	if !c.bodiesDone {
		bodies, overran := collectTestBodies(c.lines, func() bool { return c.now()-c.start > c.budgetMs })
		c.bodies, c.bodiesDone = bodies, true
		if overran && c.truncated == 0 {
			c.truncated = c.lastLine
		}
	}
	return c.bodies
}

type pragmas struct {
	byLine map[int]map[string]bool
	bare   []int
}

// pragmaMap: a pragma covers its own line and the one below, and only inside a comment.
func pragmaMap(lines []string, lang string) pragmas {
	p := pragmas{byLine: map[int]map[string]bool{}}
	for i, text := range lines {
		if !strings.Contains(text, "slop-ok") {
			continue
		}
		comment, ok := commentText(text, lang)
		if !ok {
			continue
		}
		m := pragmaRe.Find(comment)
		if m == nil {
			continue
		}
		n := i + 1
		list, _ := m.Group(1)
		if list == "" {
			p.bare = append(p.bare, n)
			continue
		}
		for _, target := range []int{n, n + 1} {
			set := p.byLine[target]
			if set == nil {
				set = map[string]bool{}
				p.byLine[target] = set
			}
			for _, id := range strings.Split(list, ",") {
				if id = jsTrim(id); id != "" {
					set[id] = true
				}
			}
		}
	}
	return p
}

var severityRank = map[string]int{"block": 0, "warn": 1}

func scan(text string, opts ScanOptions) ScanResult {
	lang := opts.Lang
	if lang == "" {
		lang = "unknown"
	}
	lines := strings.Split(text, "\n")

	if len(lines) > maxFileLines || len(text) > maxFileBytes {
		return ScanResult{Findings: []Finding{{
			RuleID: "file-too-large", Severity: "warn", Line: 1,
			Excerpt: fmt.Sprintf("%d lines", len(lines)),
			Message: fmt.Sprintf("File exceeds the scan gate (%d lines / %d bytes); no rules were run.", maxFileLines, maxFileBytes),
			Fix:     "Split the file, or add it to the path excludes if it is generated.",
		}}}
	}

	if lang == "md" {
		blankFenceInteriors(lines)
	}
	prag := pragmaMap(lines, lang)
	ctx := &scanCtx{
		lang: lang, classes: opts.Classes, lines: lines,
		now: opts.Now, budgetMs: opts.BudgetMs, lastLine: len(lines),
	}
	ctx.start = ctx.now()

	var findings []Finding
	for i := range rules {
		r := &rules[i]
		entry, configured := opts.Config[r.id]
		if entry.hasSeverity && entry.severity == "off" {
			continue
		}
		if !configured && r.offDefault {
			continue
		}
		if !ruleRuns(r, opts.Classes) {
			continue
		}
		severity := r.severity
		if entry.hasSeverity {
			severity = entry.severity
		}
		ctx.options = ruleOptions(r.id, opts.Config)
		for _, h := range r.match(ctx) {
			if prag.byLine[h.line][r.id] {
				continue
			}
			findings = append(findings, Finding{r.id, severity, h.line, h.excerpt, r.message, r.fix})
		}
	}
	for _, line := range prag.bare {
		findings = append(findings, Finding{
			"pragma-bare", "warn", line, "slop-ok",
			`Bare "slop-ok" suppresses nothing — a pragma must name the rule it silences.`,
			"Write the rule id: // slop-ok: naming-vague-generic",
		})
	}

	seen := map[string]bool{}
	deduped := findings[:0:0]
	for _, f := range findings {
		key := fmt.Sprintf("%d\x00%s\x00%s", f.Line, f.RuleID, f.Excerpt)
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, f)
		}
	}
	sort.SliceStable(deduped, func(a, b int) bool {
		x, y := deduped[a], deduped[b]
		if x.Line != y.Line {
			return x.Line < y.Line
		}
		if rx, ry := severityRank[x.Severity], severityRank[y.Severity]; rx != ry {
			return rx < ry
		}
		return x.RuleID < y.RuleID
	})
	return ScanResult{Findings: deduped, Truncated: ctx.truncated}
}

func ruleRuns(r *rule, classes map[string]bool) bool {
	for _, c := range r.classes {
		if classes[c] {
			return true
		}
	}
	return false
}
