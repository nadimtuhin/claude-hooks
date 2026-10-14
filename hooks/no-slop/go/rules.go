package main

import (
	"fmt"
	"strings"
)

const (
	maxLineLen        = 2000
	maxBraceScanLines = 2000
	maxFileLines      = 10000
	maxFileBytes      = 1024 * 1024
	maxSubjectLen     = 100
	minDensityComment = 6
	minDensityCode    = 10
)

var ruleClasses = []string{"comment", "naming", "testfile", "commit", "prose", "style"}

type hit struct {
	line    int
	excerpt string
}

type testBody struct {
	line, endLine int
	title, text   string
	empty         bool
	hasAssertion  bool
}

type rule struct {
	ruleMeta
	match func(c *scanCtx) []hit
}

// Option names per rule, in declaration order, with their defaults.
var ruleOptionNames = map[string][]string{
	"commit-subject-too-long": {"max"},
	"comment-density":         {"minComments", "minCode"},
}

var ruleOptionDefaults = map[string]map[string]float64{
	"commit-subject-too-long": {"max": maxSubjectLen},
	"comment-density":         {"minComments": minDensityComment, "minCode": minDensityCode},
}

func lineRule(re *jsRe, skipIf func(text string) bool) func(c *scanCtx) []hit {
	return func(c *scanCtx) []hit {
		var hits []hit
		c.eachCodeLine(func(n int, text string) {
			if skipIf != nil && skipIf(text) {
				return
			}
			if m := re.Find(text); m != nil {
				hits = append(hits, hit{n, jsTrim(m.Str())})
			}
		})
		return hits
	}
}

func commentRule(test func(c, raw string) bool) func(c *scanCtx) []hit {
	return func(ctx *scanCtx) []hit {
		var hits []hit
		ctx.eachCodeLine(func(n int, text string) {
			c, ok := ctx.commentOf(text)
			if !ok || c == "" {
				return
			}
			if test(c, text) {
				hits = append(hits, hit{n, jsTrim(c)})
			}
		})
		return hits
	}
}

// declaredLine is the per-line work every nameRule shares; it is a pure function of the line, so it is computed once.
type declaredLine struct {
	comment bool
	names   []string
}

func (c *scanCtx) declaredOn(n int, text string) declaredLine {
	if d, ok := c.declared[n]; ok {
		return d
	}
	if c.declared == nil {
		c.declared = map[int]declaredLine{}
	}
	_, isComment := c.commentOf(text)
	d := declaredLine{comment: isComment && commentStart(c.lang).Test(text)}
	if !d.comment {
		d.names = declaredNames(text)
	}
	c.declared[n] = d
	return d
}

func nameRule(test func(name string) bool) func(c *scanCtx) []hit {
	return func(ctx *scanCtx) []hit {
		var hits []hit
		ctx.eachCodeLine(func(n int, text string) {
			for _, name := range ctx.declaredOn(n, text).names {
				if test(name) {
					hits = append(hits, hit{n, name})
				}
			}
		})
		return hits
	}
}

type commentLine struct {
	n int
	c string
}

// commentBlocks: contiguous runs of comment lines; any other line ends a block.
func commentBlocks(ctx *scanCtx) [][]commentLine {
	var blocks [][]commentLine
	var block []commentLine
	ctx.eachCodeLine(func(n int, text string) {
		if c, ok := ctx.commentOf(text); ok {
			block = append(block, commentLine{n, c})
			return
		}
		if len(block) > 0 {
			blocks = append(blocks, block)
			block = nil
		}
	})
	if len(block) > 0 {
		blocks = append(blocks, block)
	}
	return blocks
}

func contentWords(lines []commentLine) map[string]bool {
	set := map[string]bool{}
	for _, l := range lines {
		for _, w := range words(l.c) {
			if !stopwords[w] {
				set[w] = true
			}
		}
	}
	return set
}

func matchDuplicateAdjacent(ctx *scanCtx) []hit {
	const minWords, threshold = 6, 0.6
	var hits []hit
	for _, block := range commentBlocks(ctx) {
		var paras [][]commentLine
		var cur []commentLine
		for _, l := range block {
			if jsTrim(l.c) == "" {
				if len(cur) > 0 {
					paras = append(paras, cur)
				}
				cur = nil
				continue
			}
			cur = append(cur, l)
		}
		if len(cur) > 0 {
			paras = append(paras, cur)
		}
		for i := 1; i < len(paras); i++ {
			a, b := paras[i-1], paras[i]
			wa, wb := contentWords(a), contentWords(b)
			if len(wa) < minWords || len(wb) < minWords {
				continue
			}
			shared := 0
			for w := range wa {
				if wb[w] {
					shared++
				}
			}
			smaller := len(wa)
			if len(wb) < smaller {
				smaller = len(wb)
			}
			if float64(shared)/float64(smaller) >= threshold {
				hits = append(hits, hit{b[0].n, jsTrim(b[0].c)})
			}
		}
	}
	return hits
}

func matchNarrationSteps(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		c, ok := ctx.commentOf(text)
		if ok && c != "" && narrationMarkerRe.Test(c) {
			hits = append(hits, hit{n, jsTrim(c)})
		}
	})
	var out []hit
	for _, h := range hits {
		var near []hit
		for _, o := range hits {
			if d := o.line - h.line; d >= -40 && d <= 40 {
				near = append(near, o)
			}
		}
		if len(near) >= 2 && near[0].line == h.line {
			out = append(out, h)
		}
	}
	return out
}

func matchRestatesCode(ctx *scanCtx) []hit {
	var hits []hit
	start := commentStart(ctx.lang)
	ctx.eachCodeLine(func(n int, text string) {
		c, ok := ctx.commentOf(text)
		if !ok || c == "" || !start.Test(text) {
			return
		}
		if rulerRe.Test(c) {
			return
		}
		var cw []string
		for _, w := range words(c) {
			if !stopwords[w] {
				cw = append(cw, w)
			}
		}
		if len(cw) < 2 || len(cw) > 6 {
			return
		}
		next, found := "", false
		for k := n; k < n+3 && k < len(ctx.lines); k++ {
			if l := ctx.lines[k]; jsTrim(l) != "" && !start.Test(l) {
				next, found = l, true
				break
			}
		}
		if !found {
			return
		}
		nw := map[string]bool{}
		for _, w := range words(next) {
			nw[w] = true
		}
		for _, w := range cw {
			if !nw[w] {
				return
			}
		}
		hits = append(hits, hit{n, jsTrim(c)})
	})
	return hits
}

func isRuler(s string) bool { return bannerRe.Test(jsTrim(s)) }

func matchSectionBanner(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		c, ok := ctx.commentOf(text)
		if !ok || !isRuler(c) {
			return
		}
		for _, idx := range []int{n - 2, n} {
			if idx < 0 || idx >= len(ctx.lines) {
				continue
			}
			if x, ok := ctx.commentOf(ctx.lines[idx]); ok && jsTrim(x) != "" && !isRuler(x) {
				return
			}
		}
		hits = append(hits, hit{n, jsTrim(c)})
	})
	return hits
}

func isObviousLabel(c string) bool {
	trimmed := strings.TrimRightFunc(c, func(r rune) bool {
		return strings.ContainsRune(":-=*.", r) || isJSSpace(r)
	})
	return obviousLabelRe.Test(jsTrim(trimmed))
}

func matchDensity(ctx *scanCtx) []hit {
	if ctx.lang == "md" || ctx.lang == "sh" || ctx.lang == "bash" || ctx.classes["testfile"] {
		return nil
	}
	start := commentStart(ctx.lang)
	var commentLines []int
	code := 0
	ctx.eachCodeLine(func(n int, text string) {
		if jsTrim(text) == "" {
			return
		}
		if start.Test(text) {
			commentLines = append(commentLines, n)
		} else {
			code++
		}
	})
	if float64(len(commentLines)) < ctx.options["minComments"] || float64(code) < ctx.options["minCode"] || len(commentLines) <= code {
		return nil
	}
	return []hit{{commentLines[0], fmt.Sprintf("%d comment vs %d code; lines %s", len(commentLines), code, summarizeLines(commentLines))}}
}

func matchNestedTernary(ctx *scanCtx) []hit {
	if noQuestionTernary[ctx.lang] {
		return nil
	}
	var hits []hit
	start := commentStart(ctx.lang)
	ctx.eachCodeLine(func(n int, text string) {
		if _, ok := ctx.commentOf(text); ok && start.Test(text) {
			return
		}
		if regexHintRe.Test(text) {
			return
		}
		if len(ternaryRe.FindAll(text)) >= 2 {
			hits = append(hits, hit{n, jsTrim(text)})
		}
	})
	return hits
}

func stripSpace(s string) string {
	return strings.Map(func(r rune) rune {
		if isJSSpace(r) {
			return -1
		}
		return r
	}, s)
}

func matchTautology(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		for _, re := range tautologyForms {
			m := re.Find(text)
			if m == nil {
				continue
			}
			g1, _ := m.Group(1)
			g2, _ := m.Group(2)
			if g1 != "" && g2 != "" && stripSpace(g1) == stripSpace(g2) {
				hits = append(hits, hit{n, jsTrim(m.Str())})
				break
			}
		}
		if m := tautologyLiteralRe.Find(text); m != nil {
			hits = append(hits, hit{n, jsTrim(m.Str())})
			return
		}
		if tautologySelfRe.Test(text) && assertWordRe.Test(text) {
			hits = append(hits, hit{n, jsTrim(text)})
		}
	})
	return hits
}

func matchVagueTestName(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		m := testTitleRe.Find(text)
		if m == nil {
			return
		}
		title, _ := m.Group(2)
		t := jsTrim(title)
		if vagueTitleRe.Test(t) || jsLen(t) <= 3 {
			hits = append(hits, hit{n, t})
		}
	})
	return hits
}

func nonBlankLines(s string) int {
	n := 0
	for _, l := range strings.Split(s, "\n") {
		if jsTrim(l) != "" {
			n++
		}
	}
	return n
}

// removeBlockComments is text.replace(/\/\*[\s\S]*?\*\//g, ""): once one opener has no closer, no later one can have either.
func removeBlockComments(text string) string {
	var out strings.Builder
	for {
		open := strings.Index(text, "/*")
		if open < 0 {
			break
		}
		closeAt := strings.Index(text[open+2:], "*/")
		if closeAt < 0 {
			break
		}
		out.WriteString(text[:open])
		text = text[open+2+closeAt+2:]
	}
	out.WriteString(text)
	return out.String()
}

// stripComments removes block comments, then per-line // tails.
func stripComments(text string) []string {
	lines := strings.Split(removeBlockComments(text), "\n")
	for i, l := range lines {
		lines[i] = lineCommentTail.ReplaceAll(l, "")
	}
	return lines
}

func matchDuplicateBody(ctx *scanCtx) []hit {
	var order []string
	groups := map[string][]testBody{}
	for _, b := range ctx.testBodies() {
		var kept []string
		for _, l := range stripComments(b.text) {
			if jsTrim(l) != "" {
				kept = append(kept, l)
			}
		}
		normalized := strings.Join(kept, "\n")
		normalized = quotedLiteralRe.ReplaceAll(normalized, "§")
		normalized = numberLiteralRe.ReplaceAll(normalized, "§")
		normalized = jsTrim(whitespaceRunRe.ReplaceAll(normalized, " "))
		if nonBlankLines(b.text) < 3 {
			continue
		}
		if _, seen := groups[normalized]; !seen {
			order = append(order, normalized)
		}
		groups[normalized] = append(groups[normalized], b)
	}
	var hits []hit
	for _, key := range order {
		members := groups[key]
		if len(members) < 2 {
			continue
		}
		nums := make([]int, len(members))
		for i, m := range members {
			nums[i] = m.line
		}
		hits = append(hits, hit{members[0].line, fmt.Sprintf("%d tests share this body; lines %s", len(members), summarizeLines(nums))})
	}
	return hits
}

func matchSubjectTooLong(ctx *scanCtx) []hit {
	max := ctx.options["max"]
	if n := jsLen(ctx.lines[0]); float64(n) > max {
		return []hit{{1, fmt.Sprintf("%d chars, limit %s", n, jsNumberString(max))}}
	}
	return nil
}

func matchTrailingPeriod(ctx *scanCtx) []hit {
	subject := jsTrimEnd(ctx.lines[0])
	if trailingPeriodRe.Test(subject) {
		return []hit{{1, jsSlice(subject, -24, sliceToEnd)}}
	}
	return nil
}

func matchFiller(ctx *scanCtx) []hit {
	subject := jsTrim(ctx.lines[0])
	if fillerBareRe.Test(subject) || fillerVagueRe.Test(subject) {
		return []hit{{1, subject}}
	}
	return nil
}

func matchCommitProvenance(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		if trailerRe.Test(jsTrim(text)) {
			return
		}
		if provenanceRe.Test(text) {
			hits = append(hits, hit{n, jsTrim(text)})
		}
	})
	return hits
}

func matchBodyNarration(ctx *scanCtx) []hit {
	var hits []hit
	ctx.eachCodeLine(func(n int, text string) {
		if n > 1 && bodyMetaRe.Test(jsTrim(text)) {
			hits = append(hits, hit{n, jsTrim(text)})
		}
	})
	return hits
}

func matchEmptyBody(ctx *scanCtx) []hit {
	var hits []hit
	for _, b := range ctx.testBodies() {
		if b.empty {
			hits = append(hits, hit{b.line, b.title})
		}
	}
	return hits
}

func matchNoAssertions(ctx *scanCtx) []hit {
	var hits []hit
	for _, b := range ctx.testBodies() {
		if !b.empty && !b.hasAssertion {
			hits = append(hits, hit{b.line, b.title})
		}
	}
	return hits
}

// collectTestBodies walks brace-delimited test bodies, bounded by maxBraceScanLines, maxLineLen and the time budget.
func collectTestBodies(lines []string, overBudget func() bool) (bodies []testBody, overran bool) {
	for i := 0; i < len(lines); i++ {
		if overBudget() {
			return bodies, true
		}
		if jsLen(lines[i]) > maxLineLen {
			continue
		}
		m := testOpenerRe.Find(lines[i])
		if m == nil {
			continue
		}
		depth, closed, end := 0, false, i
		var body []string
		limit := len(lines)
		if i+maxBraceScanLines < limit {
			limit = i + maxBraceScanLines
		}
		for j := i; j < limit && !closed; j++ {
			segment := lines[j]
			if j == i {
				segment = jsSlice(segment, m.End, sliceToEnd)
			}
			k := 0
			for ; k < len(segment); k++ {
				ch := segment[k]
				if ch == '{' {
					depth++
				} else if ch == '}' {
					if depth == 0 {
						closed = true
						break
					}
					depth--
				}
			}
			body = append(body, segment[:k])
			end = j
		}
		if !closed {
			overran = true
			continue
		}
		text := strings.Join(body, "\n")
		stripped := bodyJunkRe.ReplaceAll(strings.Join(stripComments(text), ""), "")
		title, _ := m.Group(2)
		bodies = append(bodies, testBody{
			line: i + 1, endLine: end + 1, title: title, text: text,
			empty: stripped == "", hasAssertion: assertionWordRe.Test(text),
		})
		i = end
	}
	return bodies, overran
}

// blankFenceInteriors blanks fenced-block interiors in place so line numbers stay stable.
func blankFenceInteriors(lines []string) {
	fence := ""
	for i := range lines {
		m := fenceRe.Find(lines[i])
		if fence == "" {
			if m != nil {
				fence, _ = m.Group(1)
			}
			continue
		}
		if m != nil {
			g, _ := m.Group(1)
			if g[0] == fence[0] && len(g) >= len(fence) {
				fence = ""
				continue
			}
		}
		lines[i] = ""
	}
}

var matchers = map[string]func(c *scanCtx) []hit{
	"comment-provenance":              commentRule(func(c, raw string) bool { return provenanceRe.Test(c) && !ticketRefRe.Test(raw) }),
	"comment-provenance-ticketed":     commentRule(func(c, raw string) bool { return provenanceRe.Test(c) && ticketRefRe.Test(raw) }),
	"comment-changelog-reference":     commentRule(func(c, _ string) bool { return changelogRefRe.Test(c) }),
	"comment-duplicate-adjacent":      matchDuplicateAdjacent,
	"comment-narration-generic-steps": matchNarrationSteps,
	"comment-restates-code":           matchRestatesCode,
	"comment-section-banner":          matchSectionBanner,
	"comment-obvious-label":           commentRule(func(c, _ string) bool { return isObviousLabel(c) }),
	"comment-density":                 matchDensity,
	"naming-inflated":                 nameRule(func(n string) bool { return inflatedUpperRe.Test(n) || inflatedLowerRe.Test(n) }),
	"naming-doubled-role":             nameRule(func(n string) bool { return doubledRoleRe.Test(n) }),
	"naming-versioned-suffix":         nameRule(func(n string) bool { return versionedRe.Test(n) }),
	"naming-redundant-type-suffix":    nameRule(func(n string) bool { return typeSuffixRe.Test(n) && !verbLedRe.Test(n) }),
	"naming-vague-generic":            nameRule(func(n string) bool { return vagueGenericRe.Test(n) }),
	"style-nested-ternary":            matchNestedTernary,
	"testfile-unconditional-skip":     lineRule(skipRe, nil),
	"testfile-only":                   lineRule(onlyRe, nil),
	"testfile-empty-body":             matchEmptyBody,
	"testfile-no-assertions":          matchNoAssertions,
	"testfile-tautology":              matchTautology,
	"testfile-vague-name":             matchVagueTestName,
	"testfile-duplicate-body":         matchDuplicateBody,
	"commit-subject-too-long":         matchSubjectTooLong,
	"commit-subject-trailing-period":  matchTrailingPeriod,
	"commit-filler":                   matchFiller,
	"commit-provenance":               matchCommitProvenance,
	"commit-body-narration":           matchBodyNarration,
	"marketing-superlative":           lineRule(marketingRe, nil),
	"prose-opener":                    lineRule(proseOpenerRe, nil),
	"prose-vocabulary-tells":          lineRule(proseVocabRe, nil),
	"prose-section-sign":              lineRule(sectionSignRe, func(t string) bool { return sectionQuotedRe.Test(t) }),
	"prose-negative-parallelism":      lineRule(negParallelRe, nil),
}

var rules = func() []rule {
	out := make([]rule, len(ruleMetas))
	for i, m := range ruleMetas {
		match, ok := matchers[m.id]
		if !ok {
			panic("no matcher for rule " + m.id)
		}
		out[i] = rule{ruleMeta: m, match: match}
	}
	return out
}()

var ruleByID = func() map[string]*rule {
	m := map[string]*rule{}
	for i := range rules {
		m[rules[i].id] = &rules[i]
	}
	return m
}()
