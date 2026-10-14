package main

import (
	"strings"
)

// Shared patterns, ported verbatim from slop-rules.mjs (a backtick is \x60).
var (
	commentStartRe   = mustJS(`^\s*(?://+|#+|--|\*|/\*+|<!--)\s?`, false)
	commentStartMdRe = mustJS(`^\s*<!--\s?`, false)
	trailingHashRe   = mustJS(`(?://|#(?!\{)|--)\s?(.*)$`, false)
	trailingSlashRe  = mustJS(`//\s?(.*)$`, false)
	httpColonEndRe   = mustJS(`https?:$`, false)
	declKeywordRe    = mustJS(`\b(?:function|class|interface|type|struct|def|func|const|let|var|enum)\s+([A-Za-z_$][\w$]*)`, false)
	declArrowRe      = mustJS(`\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(?[^)=;]*\)?\s*=>`, false)
	testTitleRe      = mustJS(`\b(?:it|test|describe|context|suite)\s*(?:\.\w+)?\s*\(\s*(['"\x60])((?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*)\1`, false)

	provenanceRe   = mustJS(`\b(?:as (?:you |the user )?(?:requested|asked|suggested)|per (?:your|the) (?:request|review|feedback|suggestion|comment)|as per (?:your|the) \w+|address(?:es|ing)? (?:the )?(?:review |reviewer )?(?:feedback|comments?)|in response to (?:your|the) (?:feedback|review|comment)|based on (?:your|the) feedback|you (?:asked|requested|wanted|mentioned)|as (?:we )?discussed(?: (?:above|earlier|offline))?|per (?:our|the) (?:discussion|conversation|chat))\b`, true)
	ticketRefRe    = mustJS(`(?:#\d+|https?://\S+|[A-Z]{2,}-\d+)`, false)
	changelogRefRe = mustJS(`\bTASK-[\w-]+|\bBUG\s*\d+\b|\bmirrors\b.*\bfix\b|\bthe same class of bug\b|\bused to\b|\bpreviously\b|\b[A-Z]\d{1,2}-\d+\b`, true)
	marketingRe    = mustJS(`\b(?:best[- ]in[- ]class|cutting[- ]edge|state[- ]of[- ]the[- ]art|world[- ]class|game[- ]chang(?:er|ing)|blazingly fast|next[- ]generation|industry[- ]leading|bulletproof|rock[- ]solid|enterprise[- ]grade)\b`, true)
	rulerRe        = mustJS(`[=\-*#~_─━═╌]{4,}|^\s*[=\-*#~─━═╌]{2,}\s.*\s[=\-*#~─━═╌]{2,}\s*$`, false)
	bannerRe       = mustJS(`^[=\-*#~_─━═╌]{8,}\s*$`, false)
	verbLedRe      = mustJS(`^(?:is|has|can|should|get|set|parse|assert|expect|to|as|from|make|new|read|write|format|render|build|create|ensure|validate|check|random|next|find|coerce|cast|convert)(?=[A-Z_])`, false)
	obviousLabelRe = mustJS(`^(?:constructor|getters?|setters?|imports?|exports?|variables?|constants?|helpers?|helper functions?|main|main function|properties|methods|types?|interfaces?|state|props|utils|utilities|initialization|init|setup|cleanup|teardown|start|begin|end|done|dependencies|configuration|config)(?:\s+section)?$`, true)
	regexHintRe    = mustJS(`^\s*/|(?:=|\(|,|:|&&|\|\||\breturn\b|\.(?:test|match|matchAll|replace|replaceAll|split))\s*/`, false)
	ternaryRe      = mustJS(`(?<!\?)\?(?![.:?])`, false)

	narrationMarkerRe = mustJS(`^(?:step\s*\d+[:.)]|first[,:]|then[,:]|next[,:]|after that[,:]|finally[,:]|now (?:we|let'?s)\b)`, true)

	inflatedUpperRe = mustJS(`^(?:Enhanced|Advanced|Smart|Ultimate|Powerful|Robust|Comprehensive|Intelligent|Optimized|Seamless|Super|Mega|Better|Improved|Modern|Sophisticated)(?=[A-Z_])`, false)
	inflatedLowerRe = mustJS(`^(?:enhanced|advanced|smart|ultimate|powerful|robust|comprehensive|intelligent|optimized|seamless|super|mega|better|improved|modern|sophisticated)(?=[A-Z_])`, false)
	doubledRoleRe   = mustJS(`(?:Manager|Handler|Service|Controller|Helper|Wrapper|Factory|Provider|Processor)(?:Manager|Handler|Service|Controller|Helper|Wrapper|Factory|Provider|Processor)$`, false)
	versionedRe     = mustJS(`.{2,}V\d+$`, false)
	typeSuffixRe    = mustJS(`^[a-z].{2,}(?:Object|String|Bool|Boolean)$`, false)
	vagueGenericRe  = mustJS(`^(?:data|info|handle|process|manager|helper|util|utils|stuff|temp|tmp|obj|thing|item|value|val|result|res|foo|bar|baz|doStuff|doIt|handleData|processData|getData|doWork)$`, true)

	skipRe = mustJS(`\b(?:describe|it|test|context|suite)\.skip\s*\(\s*['"\x60]|\bx(?:it|describe|test|context)\s*\(`, false)
	onlyRe = mustJS(`\b(?:describe|it|test|context|suite)\.only\s*\(|\bf(?:it|describe|test)\s*\(`, false)

	tautologyForms = []*jsRe{
		mustJS(`expect\s*\(\s*([^)]{1,80}?)\s*\)\s*\.(?:to)?(?:Be|Equal|StrictEqual|EqualTo|toBe|toEqual)?\s*\(\s*([^)]{1,80}?)\s*\)`, true),
		mustJS(`assert(?:\.(?:equal|strictEqual|deepEqual|deepStrictEqual))?\s*\(\s*([^,]{1,80}?)\s*,\s*([^,)]{1,80}?)\s*\)`, false),
		mustJS(`assert(?:Equals?)?\s*\(\s*([^,]{1,80}?)\s*==+\s*([^,)]{1,80}?)\s*\)`, false),
	}
	tautologyLiteralRe = mustJS(`expect\s*\(\s*(true|1|-?\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBeTruthy|toBeDefined|toBeOk)\s*\(\s*\)`, false)
	tautologySelfRe    = mustJS(`(?<![\w.$])([\w$][\w.$[\]]*)\s*===?\s*\1(?![\w.$])`, false)
	assertWordRe       = mustJS(`expect|assert|should`, false)
	vagueTitleRe       = mustJS(`^(?:should\s+)?(?:works?|work correctly|work as expected|be ok|pass|passes|test|tests|it works?|does the thing|handles? it|succeeds?|returns? correctly|behaves? correctly|is correct|basic|basics|happy path|sanity)\.?$`, true)

	lineCommentTail  = mustJS(`//.*$`, false)
	quotedLiteralRe  = mustJS(`(['"\x60])(?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*\1`, false)
	numberLiteralRe  = mustJS(`\b\d+(?:\.\d+)?\b`, false)
	whitespaceRunRe  = mustJS(`\s+`, false)
	bodyJunkRe       = mustJS(`[{}\s;]`, false)
	assertionWordRe  = mustJS(`\b(?:expect|assert|should|verify|\.to\.|chai)\b`, false)
	testOpenerRe     = mustJS(`\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"\x60])((?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*)\1\s*,\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{`, false)
	trailingPeriodRe = mustJS(`[^.]\.$`, false)

	fillerBareRe  = mustJS(`^(?:wip|misc\.?|updates?|changes?|fixes?|fixed|cleanup|clean ?up|stuff|various|final|temp|test|asdf|more (?:changes|work|fixes)|minor (?:fixes|changes|updates)|small (?:fix|change)|update code|fix stuff|refactor)\b\W*$`, true)
	fillerVagueRe = mustJS(`\b(?:various|several|assorted|some|misc\.?)\s+(?:changes|fixes|updates|improvements|tweaks|things)\b`, true)
	bodyMetaRe    = mustJS(`^(?:changes? made|summary of changes?|what changed|overview of changes?|this (?:commit|change|pr) (?:does|adds|introduces|implements|contains)|in this commit)\b`, true)
	trailerRe     = mustJS(`^(?:Co-Authored-By|Claude-Session|Signed-off-by|Reviewed-by|Tested-by|Acked-by|Cc|Fixes|Refs):`, true)

	proseOpenerRe   = mustJS(`^\s*(?:you'?re absolutely right|you'?re right|great question|excellent question|great (?:point|catch|idea)|excellent point|certainly[!,.]|absolutely[!,.]|perfect[!]|i apologize for the confusion|i appreciate (?:you|your)|thank you for (?:pointing|catching)|good catch[!.]|ah,? i see|my apologies)`, true)
	proseVocabRe    = mustJS(`\b(?:delve[sd]?|delving|tapestry|realm of|testament to|navigat(?:e|ing) the complexit(?:y|ies)|seamless(?:ly)?|holistic|myriad of|plethora of|elevate your|unlock the (?:power|potential)|embark on)\b`, true)
	sectionSignRe   = mustJS(`§+\s*\d*`, false)
	sectionQuotedRe = mustJS(`(['"\x60])[^'"\x60]*§[^'"\x60]*\1`, false)
	negParallelRe   = mustJS(`\b(?:it'?s|this is|that'?s|they'?re)\s+not\s+(?:just|merely|only|simply)\s+(?:about\s+)?[^.;]{2,60}?[,—-]\s*(?:it'?s|this is|that'?s|they'?re)\b`, true)

	pragmaRe = mustJS(`slop-ok(?::\s*([\w-]+(?:\s*,\s*[\w-]+)*))?`, false)
	fenceRe  = mustJS("^\\s*(\x60{3,}|~{3,})", false)
)

var stopwords = map[string]bool{
	"the": true, "a": true, "an": true, "to": true, "of": true, "this": true, "that": true, "we": true,
	"is": true, "are": true, "be": true, "for": true, "and": true, "or": true, "it": true, "if": true,
	"in": true, "on": true, "with": true, "from": true, "as": true, "by": true, "our": true, "its": true,
}

var hashLangs = map[string]bool{"py": true, "rb": true, "sh": true, "yaml": true, "toml": true, "pl": true, "r": true}

var noQuestionTernary = map[string]bool{"py": true, "go": true, "rs": true, "sql": true, "sh": true, "bash": true, "md": true}

func commentStart(lang string) *jsRe {
	if lang == "md" {
		return commentStartMdRe
	}
	return commentStartRe
}

// commentText is the comment on a line, or ok=false. Crude by design.
func commentText(line, lang string) (string, bool) {
	if m := commentStart(lang).Find(line); m != nil {
		return jsTrimEnd(line[len(m.Str()):]), true
	}
	re := trailingSlashRe
	if hashLangs[lang] {
		re = trailingHashRe
	}
	m := re.Find(line)
	if m == nil {
		return "", false
	}
	before := m.Prefix()
	if strings.Count(before, `"`)%2 == 1 || strings.Count(before, "'")%2 == 1 || httpColonEndRe.Test(before) {
		return "", false
	}
	g, _ := m.Group(1)
	return jsTrimEnd(g), true
}

// summarizeLines collapses numbers into ranges ("3-5, 12"), capped at 12 ranges.
func summarizeLines(nums []int) string {
	const cap = 12
	var ranges [][2]int
	for _, n := range nums {
		if l := len(ranges); l > 0 && n == ranges[l-1][1]+1 {
			ranges[l-1][1] = n
		} else {
			ranges = append(ranges, [2]int{n, n})
		}
	}
	var shown []string
	for i, r := range ranges {
		if i >= cap {
			break
		}
		if r[0] == r[1] {
			shown = append(shown, jsNumberString(float64(r[0])))
		} else {
			shown = append(shown, jsNumberString(float64(r[0]))+"-"+jsNumberString(float64(r[1])))
		}
	}
	if len(ranges) > cap {
		shown = append(shown, "…")
	}
	return strings.Join(shown, ", ")
}

func declaredNames(line string) []string {
	var names []string
	res := []*jsRe{declKeywordRe}
	if strings.Contains(line, "=>") {
		res = append(res, declArrowRe)
	}
	for _, re := range res {
		for _, m := range re.FindAll(line) {
			g, _ := m.Group(1)
			names = append(names, g)
		}
	}
	return names
}

func isASCIILetter(r rune) bool { return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') }

// words splits camelCase and drops everything that is not an ASCII letter.
func words(s string) []string {
	var out []string
	var cur []byte
	flush := func() {
		if len(cur) > 0 {
			out = append(out, string(cur))
			cur = cur[:0]
		}
	}
	var prev rune
	for _, r := range s {
		switch {
		case !isASCIILetter(r):
			flush()
		case r >= 'A' && r <= 'Z':
			if prev >= 'a' && prev <= 'z' {
				flush()
			}
			cur = append(cur, byte(r+'a'-'A'))
		default:
			cur = append(cur, byte(r))
		}
		prev = r
	}
	flush()
	return out
}
