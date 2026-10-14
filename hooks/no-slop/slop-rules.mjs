// no-slop rule tables and the scanner.
//
// Pure module: no I/O, no process access. Everything the scanner needs arrives
// through arguments so the whole rule set is testable without a filesystem.
//
// CONTRACT
//
//   scan(text, { lang, ruleClasses, config, budgetMs, now })
//
//   ruleClasses  Set of 'comment' | 'naming' | 'testfile' | 'commit' | 'prose'.
//                Callers compose it; a rule runs only if one of its classes is
//                in the set. This is deliberately two axes, not one enum: a
//                test file is both a test file and a code file.
//   config       { "<ruleId>": "off" | "warn" | "block" }, or the object form
//                { "<ruleId>": { severity?, ...options } } for rules with a
//                tunable threshold (see RULE_OPTIONS). Read severity and options
//                only through validateConfig / ruleOptions — a site that
//                string-compares the raw value silently ignores the object form.
//   budgetMs     wall-clock ceiling, checked every 500 lines.
//
//   returns { findings, truncated }
//
//   findings is a flat list, one entry per (line, ruleId), deduped on the exact
//   (line, ruleId, excerpt) triple, sorted by (line asc, block before warn,
//   ruleId asc). Each finding is { ruleId, severity, line, excerpt, message, fix }.

export const RULE_CLASSES = ['comment', 'naming', 'testfile', 'commit', 'prose', 'style'];

const MAX_LINE_LEN = 2000; // longer lines are minified/generated; skip before regex
const MAX_BRACE_SCAN_LINES = 2000; // bound on the test-body brace walk
// The gate exists so the hook never stalls a write, not to express an opinion about file size.
// Measured cost is ~0.02ms/line (a 1500-line TypeScript file scans in ~20ms), so the old 1500-line
// ceiling was buying nothing and cost real coverage: the files that most accumulate slop are exactly
// the god-files that sit just over it, and they were being skipped entirely. 10k lines is ~200ms
// worst case — still imperceptible on a PostToolUse hook — while genuinely pathological or generated
// files still bail.
export const MAX_FILE_LINES = 10000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SUBJECT_LEN = 100;

// Below either floor a file is too small for the ratio to mean anything. Both sides
// need a floor: a one-function module with a header explaining the trap it exists for
// clears the comment floor on the header alone, and no edit short of deleting the
// explanation gets it back under the line.
export const MIN_DENSITY_COMMENTS = 6;
export const MIN_DENSITY_CODE = 10;

// ---------------------------------------------------------------------------
// small helpers shared by rules
// ---------------------------------------------------------------------------

const COMMENT_START = /^\s*(?:\/\/+|#+|--|\*|\/\*+|<!--)\s?/;
// In markdown `#` opens a heading and `*`/`--` open list items and rules — none of
// them are comments. Without this every README heading reads as a comment and the
// comment rules fire on ordinary prose. An HTML comment is the only real one.
const COMMENT_START_MD = /^\s*<!--\s?/;
const commentStart = (lang) => (lang === 'md' ? COMMENT_START_MD : COMMENT_START);
const TRAILING_COMMENT = /(?:\/\/|#(?!\{)|--)\s?(.*)$/;

/** Comment text on a line, or null. Crude by design — a tripwire, not a parser. */
function commentText(line, lang) {
  const full = line.match(commentStart(lang));
  if (full) return line.slice(full[0].length).trimEnd();
  // Trailing comment after code. Hash comments only where # actually starts one.
  const hashLangs = new Set(['py', 'rb', 'sh', 'yaml', 'toml', 'pl', 'r']);
  const re = hashLangs.has(lang) ? TRAILING_COMMENT : /\/\/\s?(.*)$/;
  const m = line.match(re);
  if (!m) return null;
  // Ignore matches inside an obvious string or URL.
  const before = line.slice(0, m.index);
  if ((before.match(/"/g) || []).length % 2 === 1) return null;
  if ((before.match(/'/g) || []).length % 2 === 1) return null;
  if (/https?:$/.test(before)) return null;
  return m[1].trimEnd();
}

/** Line numbers as collapsed ranges ("3-5, 12, 19-24"), capped so the excerpt stays readable. */
function summarizeLines(nums, cap = 12) {
  const ranges = [];
  for (const n of nums) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const shown = ranges.slice(0, cap).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  if (ranges.length > cap) shown.push('…');
  return shown.join(', ');
}

/** Names introduced by a declaration on this line. */
const DECL_KEYWORD = /\b(?:function|class|interface|type|struct|def|func|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
const DECL_ARROW = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(?[^)=;]*\)?\s*=>/g;

function declaredNames(line) {
  const names = [];
  for (const re of [DECL_KEYWORD, DECL_ARROW]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) names.push(m[1]);
  }
  return names;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'this', 'that', 'we', 'is', 'are', 'be', 'for',
  'and', 'or', 'it', 'if', 'in', 'on', 'with', 'from', 'as', 'by', 'our', 'its',
]);

function words(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

/** Sequential test titles: the string literal passed to it/test/describe. */
const TEST_TITLE = /\b(?:it|test|describe|context|suite)\s*(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/** Contiguous runs of comment lines — a non-comment line (code or blank) ends a block. */
function* commentBlocks(ctx) {
  let block = [];
  for (const { n, text } of ctx.codeLines()) {
    const c = commentText(text, ctx.lang);
    if (c !== null) {
      block.push({ n, c });
      continue;
    }
    if (block.length) { yield block; block = []; }
  }
  if (block.length) yield block;
}

// ---------------------------------------------------------------------------
// rule authoring helpers
// ---------------------------------------------------------------------------

/** A rule that fires once per matching line. */
function lineRule(re, { skipIf } = {}) {
  return function* (ctx) {
    for (const { n, text } of ctx.codeLines()) {
      if (skipIf && skipIf(text, ctx)) continue;
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) yield { line: n, excerpt: m[0].trim() };
    }
  };
}

/** A rule over comment text only. */
function commentRule(test) {
  return function* (ctx) {
    for (const { n, text } of ctx.codeLines()) {
      const c = commentText(text, ctx.lang);
      if (c === null || c === '') continue;
      const hit = test(c, text, ctx);
      if (hit) yield { line: n, excerpt: (typeof hit === 'string' ? hit : c).trim() };
    }
  };
}

/** A rule over each declared identifier. */
function nameRule(test) {
  return function* (ctx) {
    for (const { n, text } of ctx.codeLines()) {
      if (commentText(text, ctx.lang) !== null && commentStart(ctx.lang).test(text)) continue;
      for (const name of declaredNames(text)) {
        if (test(name)) yield { line: n, excerpt: name };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// shared patterns
// ---------------------------------------------------------------------------

// Second-person / review provenance. Narrow on purpose: this is the mechanical
// "AI edit log left in the source" tell, not general past-tense prose.
const PROVENANCE = /\b(?:as (?:you |the user )?(?:requested|asked|suggested)|per (?:your|the) (?:request|review|feedback|suggestion|comment)|as per (?:your|the) \w+|address(?:es|ing)? (?:the )?(?:review |reviewer )?(?:feedback|comments?)|in response to (?:your|the) (?:feedback|review|comment)|based on (?:your|the) feedback|you (?:asked|requested|wanted|mentioned)|as (?:we )?discussed(?: (?:above|earlier|offline))?|per (?:our|the) (?:discussion|conversation|chat))\b/i;

const TICKET_REF = /(?:#\d+|https?:\/\/\S+|[A-Z]{2,}-\d+)/;

// Third-person changelog narration: a comment about the CODE's history (a ticket
// reference, a past bug, a "how it behaved before" aside) rather than a second-
// person review exchange. PROVENANCE is anchored on "as you/the user requested"
// and never matches this. The bare-identifier alternative at the end catches a
// short letter+digit-then-number id with no ticket-word prefix in front of it.
const CHANGELOG_REF = /\bTASK-[\w-]+|\bBUG\s*\d+\b|\bmirrors\b.*\bfix\b|\bthe same class of bug\b|\bused to\b|\bpreviously\b|\b[A-Z]\d{1,2}-\d+\b/i;

const MARKETING = /\b(?:best[- ]in[- ]class|cutting[- ]edge|state[- ]of[- ]the[- ]art|world[- ]class|game[- ]chang(?:er|ing)|blazingly fast|next[- ]generation|industry[- ]leading|bulletproof|rock[- ]solid|enterprise[- ]grade)\b/i;

// A ruler: either a long run of divider characters, or a short run bookending
// a label (`--- Mark read ---`). Both are navigation aids, not prose.
const RULER = /[=\-*#~_─━═╌]{4,}|^\s*[=\-*#~─━═╌]{2,}\s.*\s[=\-*#~─━═╌]{2,}\s*$/;

// A verb-led name describes what it returns or checks, so a trailing type word
// is carrying meaning: assertString, parseSqliteBoolean, randomInt.
const VERB_LED = /^(?:is|has|can|should|get|set|parse|assert|expect|to|as|from|make|new|read|write|format|render|build|create|ensure|validate|check|random|next|find|coerce|cast|convert)(?=[A-Z_])/;

const OBVIOUS_LABEL = /^(?:constructor|getters?|setters?|imports?|exports?|variables?|constants?|helpers?|helper functions?|main|main function|properties|methods|types?|interfaces?|state|props|utils|utilities|initialization|init|setup|cleanup|teardown|start|begin|end|done|dependencies|configuration|config)(?:\s+section)?$/i;

// A regex literal is soup with `?`: `(?:`, `(?=`, `[x]?`, lazy `*?`/`+?` all use it as a
// quantifier/lookaround marker, not a ternary. There is no reliable per-character way to
// tell those apart from a real ternary `?` (a quantifier can be followed by anything the
// rest of the pattern needs), so a line that looks like it opens a regex literal is
// skipped for ternary-counting entirely rather than guessed at.
// Every `?` in these is a regex quantifier, glob, or Rust's `?` operator — never a ternary.
const NO_QUESTION_TERNARY = new Set(['py', 'go', 'rs', 'sql', 'sh', 'bash', 'md']);
const REGEX_LITERAL_HINT =/^\s*\/|(?:=|\(|,|:|&&|\|\||\breturn\b|\.(?:test|match|matchAll|replace|replaceAll|split))\s*\//;

// ---------------------------------------------------------------------------
// the rules
// ---------------------------------------------------------------------------

/** @type {Array<{id,classes,severity,enabled,message,fix,match}>} */
export const RULES = [
  // --- comment ------------------------------------------------------------
  {
    id: 'comment-provenance',
    classes: ['comment'],
    severity: 'block',
    message: 'Comment records why the edit was made, not what the code means.',
    fix: 'Delete the line. If the reason matters, state the invariant instead: "// callers may pass null; the guard below is load-bearing".',
    match: commentRule((c, raw) => PROVENANCE.test(c) && !TICKET_REF.test(raw)),
  },
  {
    id: 'comment-provenance-ticketed',
    classes: ['comment'],
    severity: 'warn',
    message: 'Provenance comment carrying a ticket reference.',
    fix: 'Keep the ticket link, drop the narration: "// see #412" rather than "// changed per review, see #412".',
    match: commentRule((c, raw) => PROVENANCE.test(c) && TICKET_REF.test(raw)),
  },
  {
    id: 'comment-changelog-reference',
    classes: ['comment'],
    severity: 'warn',
    message: 'Comment narrates repo history (a ticket, a past bug, "used to"/"previously") instead of stating the invariant.',
    fix: 'Rewrite as the current invariant and drop the reference: "release the lock only after the drain completes", not "TASK-35: release the lock only after...".',
    // Deliberately warn, not block: some of these encode a real invariant (a
    // lock-ordering rule tied to a ticket is still load-bearing) — deciding what
    // to keep vs. rewrite is a human judgement call, not a regex's. The habitual-
    // past-tense pair (see the alternation above) is the noisiest part of this
    // rule, but it stays merged rather than split: at warn severity an occasional
    // hit on legitimate prose is cheap, and a second near-identical rule would buy
    // no extra precision.
    match: commentRule((c) => CHANGELOG_REF.test(c)),
  },
  {
    id: 'comment-duplicate-adjacent',
    classes: ['comment'],
    severity: 'warn',
    message: 'Two adjacent comment paragraphs restate the same fact — the classic residue of a new explanation prepended without deleting the stale one.',
    fix: 'Delete whichever paragraph is wrong or stale; keep one explanation.',
    // Threshold: containment ratio (shared content words / smaller side's content-word
    // count) >= 0.6, each side needing >=6 content words first so a short title/label
    // line (e.g. a one-line file banner) can't trip it against the paragraph below it.
    // Containment rather than Jaccard because the two paragraphs are rarely the same
    // length (the fb-desktop residue case: a 3-line stale explanation followed by a
    // 1-line replacement) — Jaccard would undercount that as a big union. 0.6 was
    // picked against that real case (>0.8 overlap) vs. ordinary back-to-back prose
    // about the same topic that isn't a duplicate (~0.3-0.5 overlap on the test
    // table below).
    match: function* (ctx) {
      const MIN_WORDS = 6;
      const THRESHOLD = 0.6;
      for (const block of commentBlocks(ctx)) {
        const paras = [];
        let cur = [];
        for (const { n, c } of block) {
          if (c.trim() === '') {
            if (cur.length) paras.push(cur);
            cur = [];
            continue;
          }
          cur.push({ n, c });
        }
        if (cur.length) paras.push(cur);
        for (let i = 1; i < paras.length; i++) {
          const a = paras[i - 1];
          const b = paras[i];
          const wa = new Set(a.flatMap((l) => words(l.c)).filter((w) => !STOPWORDS.has(w)));
          const wb = new Set(b.flatMap((l) => words(l.c)).filter((w) => !STOPWORDS.has(w)));
          if (wa.size < MIN_WORDS || wb.size < MIN_WORDS) continue;
          const shared = [...wa].filter((w) => wb.has(w)).length;
          const ratio = shared / Math.min(wa.size, wb.size);
          if (ratio >= THRESHOLD) yield { line: b[0].n, excerpt: b[0].c.trim() };
        }
      }
    },
  },
  {
    id: 'comment-narration-generic-steps',
    classes: ['comment'],
    severity: 'warn',
    message: 'Sequential step narration ("Step 1 / First / Then / Finally") walking the reader through code they can already read.',
    fix: 'Delete the markers. If the sequence is genuinely non-obvious, name the phases as functions instead.',
    match: function* (ctx) {
      const marker = /^(?:step\s*\d+[:.)]|first[,:]|then[,:]|next[,:]|after that[,:]|finally[,:]|now (?:we|let'?s)\b)/i;
      const hits = [];
      for (const { n, text } of ctx.codeLines()) {
        const c = commentText(text, ctx.lang);
        if (c && marker.test(c)) hits.push({ line: n, excerpt: c.trim() });
      }
      // Multiplicity gate: 2+ markers within a 40-line window. A lone "First,"
      // is ordinary prose; a run of them is narration.
      for (let i = 0; i < hits.length; i++) {
        const near = hits.filter((h) => Math.abs(h.line - hits[i].line) <= 40);
        if (near.length >= 2 && near[0].line === hits[i].line) yield hits[i];
      }
    },
  },
  {
    id: 'comment-restates-code',
    classes: ['comment'],
    severity: 'warn',
    message: 'Comment restates the line below it in English.',
    fix: 'Delete it. A comment earns its place by saying WHY, or naming an invariant the code cannot express.',
    match: function* (ctx) {
      const lines = ctx.lines;
      for (const { n, text } of ctx.codeLines()) {
        const c = commentText(text, ctx.lang);
        if (!c || !commentStart(ctx.lang).test(text)) continue;
        // A labelled divider (`─── parseInvoice ───`) names the section below
        // it. That reads as restatement to a word-subset check, but it is a
        // navigation aid, not prose about the code.
        if (RULER.test(c)) continue;
        const cw = words(c).filter((w) => !STOPWORDS.has(w));
        if (cw.length < 2 || cw.length > 6) continue;
        const next = lines.slice(n, n + 3).find((l) => l.trim() && !commentStart(ctx.lang).test(l));
        if (!next) continue;
        const nw = new Set(words(next));
        if (cw.every((w) => nw.has(w))) yield { line: n, excerpt: c.trim() };
      }
    },
  },
  {
    id: 'comment-section-banner',
    classes: ['comment'],
    severity: 'warn',
    message: 'Decorative ASCII banner comment.',
    fix: 'Delete the rule line. If the file needs sections that badly, split the file.',
    // Unlabelled only. A section name may sit on the ruler line itself
    // (`--- Mark read ---`) or on the comment line next to it — the common
    // three-line block form. Either way the ruler is a navigation aid.
    match: function* (ctx) {
      const isRuler = (s) => /^[=\-*#~_─━═╌]{8,}\s*$/.test(s.trim());
      for (const { n, text } of ctx.codeLines()) {
        const c = commentText(text, ctx.lang);
        if (c === null || !isRuler(c)) continue;
        const neighbours = [ctx.lines[n - 2], ctx.lines[n]]
          .map((l) => (l === undefined ? null : commentText(l, ctx.lang)));
        if (neighbours.some((x) => x !== null && x.trim() !== '' && !isRuler(x))) continue;
        yield { line: n, excerpt: c.trim() };
      }
    },
  },
  {
    id: 'comment-obvious-label',
    classes: ['comment'],
    severity: 'warn',
    message: 'Comment labels a construct the syntax already names.',
    fix: 'Delete it — "// Constructor" above a constructor tells the reader nothing.',
    match: commentRule((c) => OBVIOUS_LABEL.test(c.replace(/[:\-=*.\s]+$/, '').trim())),
  },
  {
    id: 'comment-density',
    classes: ['comment'],
    severity: 'warn',
    message: 'File has more comment lines than code lines.',
    fix: 'Delete the comments that restate the code. Keep the ones naming a trap or a non-obvious why — those are the shortest path back under the line, not the longest.',
    // Whole-file, not per-diff: the scanner never sees a diff, so this measures the
    // file's overall density. Weaker than "this edit added more comments than code",
    // but it needs no new architecture, and the baseline file grandfathers files that
    // are historically comment-heavy.
    //
    // Skips prose (md) and shell, where a high comment ratio is the convention, and
    // test files, where a comment per case is normal.
    match: function* (ctx) {
      if (ctx.lang === 'md' || ctx.lang === 'sh' || ctx.lang === 'bash') return;
      if (ctx.classes.has('testfile')) return;
      const commentLines = [];
      let code = 0;
      for (const { n, text } of ctx.codeLines()) {
        if (text.trim() === '') continue;
        if (commentStart(ctx.lang).test(text)) commentLines.push(n);
        else code++;
      }
      if (commentLines.length < ctx.options.minComments) return;
      // A file with no code at all is a stub or a licence header, not a density problem.
      if (code < ctx.options.minCode) return;
      if (commentLines.length <= code) return;
      // The counted lines go in the excerpt so the cheap way to comply is deleting
      // narration, not deleting whichever comment happens to be longest — which is
      // systematically the one documenting a trap.
      yield {
        line: commentLines[0],
        excerpt: `${commentLines.length} comment vs ${code} code; lines ${summarizeLines(commentLines)}`,
      };
    },
  },

  // --- naming -------------------------------------------------------------
  {
    id: 'naming-inflated',
    classes: ['naming'],
    severity: 'warn',
    message: 'Identifier opens with a self-congratulatory adjective.',
    fix: 'Name what it does, not how good it is: EnhancedParser → StreamingParser, SmartCache → LruCache.',
    match: nameRule((name) =>
      /^(?:Enhanced|Advanced|Smart|Ultimate|Powerful|Robust|Comprehensive|Intelligent|Optimized|Seamless|Super|Mega|Better|Improved|Modern|Sophisticated)(?=[A-Z_])/.test(name) ||
      /^(?:enhanced|advanced|smart|ultimate|powerful|robust|comprehensive|intelligent|optimized|seamless|super|mega|better|improved|modern|sophisticated)(?=[A-Z_])/.test(name)),
  },
  {
    id: 'naming-doubled-role',
    classes: ['naming'],
    severity: 'warn',
    message: 'Identifier stacks two role suffixes.',
    fix: 'Keep one: ProfileManagerService → ProfileStore. If both roles are real, it is two types.',
    match: nameRule((name) =>
      /(?:Manager|Handler|Service|Controller|Helper|Wrapper|Factory|Provider|Processor)(?:Manager|Handler|Service|Controller|Helper|Wrapper|Factory|Provider|Processor)$/.test(name)),
  },
  {
    id: 'naming-versioned-suffix',
    classes: ['naming'],
    severity: 'warn',
    message: 'Identifier versioned by suffix instead of by replacing the old one.',
    fix: 'Delete the old definition and keep the plain name: parseConfigV2 → parseConfig.',
    // Numeric versions only. New/Old/Copy/Temp/Legacy read as ordinary English
    // in real code (openNew, handleCopy, downloadImageToTemp, seedLegacy) and
    // produced nothing but false positives on the corpus sweep.
    match: nameRule((name) => /.{2,}V\d+$/.test(name)),
  },
  {
    id: 'naming-redundant-type-suffix',
    classes: ['naming'],
    severity: 'warn',
    message: 'Identifier repeats its own type in the name.',
    fix: 'Drop the suffix: userObject → user, nameString → name. The type annotation already says it.',
    // Number/Int are excluded: "number" usually means a numeral or an id
    // (dealerNumber, clicksNumber), not the type.
    match: nameRule((name) => /^[a-z].{2,}(?:Object|String|Bool|Boolean)$/.test(name) && !VERB_LED.test(name)),
  },
  {
    id: 'naming-vague-generic',
    classes: ['naming'],
    severity: 'warn',
    enabled: false, // ships off: never had an adversarial false-positive pass
    message: 'Identifier is a placeholder rather than a name.',
    fix: 'Say what it holds or does: processData → normalizeInvoiceRows, helper → formatCurrency.',
    match: nameRule((name) =>
      /^(?:data|info|handle|process|manager|helper|util|utils|stuff|temp|tmp|obj|thing|item|value|val|result|res|foo|bar|baz|doStuff|doIt|handleData|processData|getData|doWork)$/i.test(name)),
  },

  // --- style ----------------------------------------------------------------
  {
    id: 'style-nested-ternary',
    classes: ['style'],
    severity: 'warn',
    message: 'Nested ternary — a ternary inside another ternary\'s branch reads left-to-right but evaluates outside-in.',
    fix: 'Rewrite as if/else, or extract each branch into a named function.',
    // Ternary `?` only: `?.` (optional chaining), `??` (nullish coalescing), and
    // `?:` (an optional param/property with nothing between the `?` and the `:`,
    // which a real ternary can never have — its branch is never empty) are excluded.
    // Two or more on one line is the tripwire; a single ternary is normal, idiomatic
    // code and stays quiet.
    match: function* (ctx) {
      if (NO_QUESTION_TERNARY.has(ctx.lang)) return;
      for (const { n, text } of ctx.codeLines()) {
        if (commentText(text, ctx.lang) !== null && commentStart(ctx.lang).test(text)) continue;
        if (REGEX_LITERAL_HINT.test(text)) continue;
        const ternaryOps = (text.match(/(?<!\?)\?(?![.:?])/g) || []).length;
        if (ternaryOps >= 2) yield { line: n, excerpt: text.trim() };
      }
    },
  },

  // --- testfile -----------------------------------------------------------
  {
    id: 'testfile-unconditional-skip',
    classes: ['testfile'],
    severity: 'block',
    message: 'Test is skipped unconditionally.',
    fix: 'Delete the test or make it pass. For a genuinely conditional skip use the runtime form — test.skip(isCI, "reason") — which this rule ignores.',
    // A string first argument means the *suite/case* is being skipped outright.
    // Playwright's conditional `test.skip(cond, reason)` passes an expression,
    // so it does not match, which is the whole point of anchoring on the quote.
    match: lineRule(/\b(?:describe|it|test|context|suite)\.skip\s*\(\s*['"`]|\bx(?:it|describe|test|context)\s*\(/),
  },
  {
    id: 'testfile-only',
    classes: ['testfile'],
    severity: 'block',
    message: 'Focused test will silently skip the rest of the suite.',
    fix: 'Remove .only before committing.',
    match: lineRule(/\b(?:describe|it|test|context|suite)\.only\s*\(|\bf(?:it|describe|test)\s*\(/),
  },
  {
    id: 'testfile-empty-body',
    classes: ['testfile'],
    severity: 'block',
    message: 'Test body is empty — it passes without asserting anything.',
    fix: 'Write the assertion, or delete the case. An always-green test is worse than no test.',
    match: function* (ctx) {
      for (const b of ctx.testBodies()) if (b.empty) yield { line: b.line, excerpt: b.title };
    },
  },
  {
    id: 'testfile-no-assertions',
    classes: ['testfile'],
    severity: 'warn',
    message: 'Test body has statements but no assertion.',
    fix: 'Add the expect/assert that would fail if the behaviour broke.',
    match: function* (ctx) {
      for (const b of ctx.testBodies()) if (!b.empty && !b.hasAssertion) yield { line: b.line, excerpt: b.title };
    },
  },
  {
    id: 'testfile-tautology',
    classes: ['testfile'],
    severity: 'block',
    message: 'Assertion compares a value to itself and can never fail.',
    fix: 'Assert against the expected literal, not against the same expression.',
    match: function* (ctx) {
      const forms = [
        /expect\s*\(\s*([^)]{1,80}?)\s*\)\s*\.(?:to)?(?:Be|Equal|StrictEqual|EqualTo|toBe|toEqual)?\s*\(\s*([^)]{1,80}?)\s*\)/i,
        /assert(?:\.(?:equal|strictEqual|deepEqual|deepStrictEqual))?\s*\(\s*([^,]{1,80}?)\s*,\s*([^,)]{1,80}?)\s*\)/,
        /assert(?:Equals?)?\s*\(\s*([^,]{1,80}?)\s*==+\s*([^,)]{1,80}?)\s*\)/,
      ];
      const norm = (s) => s.replace(/\s+/g, '');
      for (const { n, text } of ctx.codeLines()) {
        for (const re of forms) {
          const m = text.match(re);
          if (m && m[1] && m[2] && norm(m[1]) === norm(m[2])) {
            yield { line: n, excerpt: m[0].trim() };
            break;
          }
        }
        // The lookbehind matters: without it `m.id === id` reads as a
        // self-comparison, because a word boundary sits right after the dot.
        // A literal asserted truthy is the same always-green shape.
        const literal = text.match(/expect\s*\(\s*(true|1|-?\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBeTruthy|toBeDefined|toBeOk)\s*\(\s*\)/);
        if (literal) {
          yield { line: n, excerpt: literal[0].trim() };
          continue;
        }
        if (/(?<![\w.$])([\w$][\w.$[\]]*)\s*===?\s*\1(?![\w.$])/.test(text) && /expect|assert|should/.test(text)) {
          yield { line: n, excerpt: text.trim() };
        }
      }
    },
  },
  {
    id: 'testfile-vague-name',
    classes: ['testfile'],
    severity: 'warn',
    message: 'Test title does not say what behaviour is expected.',
    fix: 'Name the behaviour and the condition: "returns 404 when the id is unknown".',
    match: function* (ctx) {
      const vague = /^(?:should\s+)?(?:works?|work correctly|work as expected|be ok|pass|passes|test|tests|it works?|does the thing|handles? it|succeeds?|returns? correctly|behaves? correctly|is correct|basic|basics|happy path|sanity)\.?$/i;
      for (const { n, text } of ctx.codeLines()) {
        const m = text.match(TEST_TITLE);
        if (m && (vague.test(m[2].trim()) || m[2].trim().length <= 3)) {
          yield { line: n, excerpt: m[2].trim() };
        }
      }
    },
  },

  {
    id: 'testfile-duplicate-body',
    classes: ['testfile'],
    severity: 'warn',
    message: 'Two or more tests have the same body apart from their literals.',
    fix: 'Collapse into it.each over the varying literal. Keep the titles distinct in the table or a failure stops naming which case broke.',
    // Blind to it.each tables by construction: collectTestBodies only opens on a
    // quoted title, so a table is never collected and can never be reported as its
    // own duplicate. Accepted — the rule exists to push code TOWARDS tables.
    match: function* (ctx) {
      const groups = new Map();
      for (const b of ctx.testBodies()) {
        // Literals are what legitimately varies between sibling cases, so they are
        // masked before hashing; anything still differing is real structure.
        const normalized = b.text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .map((l) => l.replace(/\/\/.*$/, ''))
          .filter((l) => l.trim() !== '')
          .join('\n')
          .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '§')
          .replace(/\b\d+(?:\.\d+)?\b/g, '§')
          .replace(/\s+/g, ' ')
          .trim();
        // Under three real lines, every `expect(x).toBe(1)` one-liner pairs up.
        if (b.text.split('\n').filter((l) => l.trim()).length < 3) continue;
        if (!groups.has(normalized)) groups.set(normalized, []);
        groups.get(normalized).push(b);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        // ONE finding per group, at the first member. Yielding per hit would let a
        // single 4-way duplicate consume the whole WARN_CAP and hide the rest.
        yield {
          line: members[0].line,
          excerpt: `${members.length} tests share this body; lines ${summarizeLines(members.map((m) => m.line))}`,
        };
      }
    },
  },

  // --- commit -------------------------------------------------------------
  {
    id: 'commit-subject-too-long',
    classes: ['commit'],
    severity: 'block',
    // The limit is in the excerpt, not this message: it is configurable per repo via
    // .no-slop.json, so a number baked in here would lie wherever it was overridden.
    message: 'Commit subject is over the configured length limit.',
    fix: 'Trim the subject to the change itself and move the detail to the body after a blank line. 72 is the convention worth aiming at.',
    // The DEFAULT ceiling is 100, not the conventional 72. Over 300 real commits from
    // a working repo, 72 fired 151 times and 100 fired 18 — a gate that stops half of
    // all commits gets disabled in a week, which costs more than it saves. A repo that
    // wants 72 sets it explicitly rather than having it imposed.
    match: function* (ctx) {
      const subject = ctx.lines[0] ?? '';
      const { max } = ctx.options;
      if (subject.length > max) yield { line: 1, excerpt: `${subject.length} chars, limit ${max}` };
    },
  },
  {
    id: 'commit-subject-trailing-period',
    classes: ['commit'],
    severity: 'block',
    message: 'Commit subject ends with a period.',
    fix: 'Drop the final period — the subject is a title, not a sentence.',
    match: function* (ctx) {
      const subject = (ctx.lines[0] ?? '').trimEnd();
      if (/[^.]\.$/.test(subject)) yield { line: 1, excerpt: subject.slice(-24) };
    },
  },
  {
    id: 'commit-filler',
    classes: ['commit'],
    severity: 'warn',
    message: 'Commit subject says a change happened without saying what changed.',
    fix: 'Name the behaviour: "fix null deref when the profile lock is stale".',
    match: function* (ctx) {
      const subject = (ctx.lines[0] ?? '').trim();
      const bare = /^(?:wip|misc\.?|updates?|changes?|fixes?|fixed|cleanup|clean ?up|stuff|various|final|temp|test|asdf|more (?:changes|work|fixes)|minor (?:fixes|changes|updates)|small (?:fix|change)|update code|fix stuff|refactor)\b\W*$/i;
      const vague = /\b(?:various|several|assorted|some|misc\.?)\s+(?:changes|fixes|updates|improvements|tweaks|things)\b/i;
      if (bare.test(subject) || vague.test(subject)) yield { line: 1, excerpt: subject };
    },
  },
  {
    id: 'commit-provenance',
    classes: ['commit'],
    severity: 'warn',
    message: 'Commit message narrates the review conversation rather than the change.',
    fix: 'Describe the code change; the review thread already records the discussion.',
    match: function* (ctx) {
      for (const { n, text } of ctx.codeLines()) {
        if (ctx.isTrailer(text)) continue;
        if (PROVENANCE.test(text)) yield { line: n, excerpt: text.trim() };
      }
    },
  },
  {
    id: 'commit-body-narration',
    classes: ['commit'],
    severity: 'warn',
    message: 'Commit body opens with a meta-heading instead of the change.',
    fix: 'Delete the heading and start with the change: bullet the behaviour differences directly.',
    match: function* (ctx) {
      const meta = /^(?:changes? made|summary of changes?|what changed|overview of changes?|this (?:commit|change|pr) (?:does|adds|introduces|implements|contains)|in this commit)\b/i;
      for (const { n, text } of ctx.codeLines()) {
        if (n > 1 && meta.test(text.trim())) yield { line: n, excerpt: text.trim() };
      }
    },
  },

  // --- shared -------------------------------------------------------------
  {
    id: 'marketing-superlative',
    classes: ['commit', 'prose'],
    severity: 'block',
    message: 'Marketing superlative in engineering text.',
    fix: 'State the measurable claim instead: "cutting-edge parser" → "handles streaming input without buffering".',
    match: lineRule(MARKETING),
  },

  // --- prose --------------------------------------------------------------
  {
    id: 'prose-opener',
    classes: ['prose'],
    severity: 'block',
    message: 'Reflexive agreement/flattery opener.',
    fix: 'Delete the opener and start with the answer.',
    match: lineRule(/^\s*(?:you'?re absolutely right|you'?re right|great question|excellent question|great (?:point|catch|idea)|excellent point|certainly[!,.]|absolutely[!,.]|perfect[!]|i apologize for the confusion|i appreciate (?:you|your)|thank you for (?:pointing|catching)|good catch[!.]|ah,? i see|my apologies)/i),
  },
  {
    id: 'prose-vocabulary-tells',
    classes: ['prose'],
    severity: 'warn',
    message: 'Rhetorical filler vocabulary — reads as padding rather than information.',
    // Wording matters: this flags rhetorical habit, not incorrect English.
    fix: 'Swap for the plain verb: delve → look into, leverage → use, seamless → without extra setup, myriad of → many.',
    match: lineRule(/\b(?:delve[sd]?|delving|tapestry|realm of|testament to|navigat(?:e|ing) the complexit(?:y|ies)|seamless(?:ly)?|holistic|myriad of|plethora of|elevate your|unlock the (?:power|potential)|embark on)\b/i),
  },
  {
    id: 'prose-section-sign',
    classes: ['prose', 'comment'],
    severity: 'warn',
    message: 'Section sign (§) — legal-citation punctuation almost nobody types by hand in engineering notes.',
    fix: 'Write it out: "§7" → "section 7", or link the heading. In a code fence, quote it.',
    // skipIf spares a quoted one — this module masks string literals to that character.
    // slop-ok: prose-section-sign — a rule has to name what it forbids.
    match: lineRule(/§+\s*\d*/, { skipIf: (t) => /(['"`])[^'"`]*§[^'"`]*\1/.test(t) }),
  },
  {
    id: 'prose-negative-parallelism',
    classes: ['prose'],
    severity: 'warn',
    message: 'Not-just-X-it\'s-Y construction — rhetorical shape carrying no extra information.',
    fix: 'Keep only the positive half: say what it is and drop the "not just" clause.',
    match: lineRule(/\b(?:it'?s|this is|that'?s|they'?re)\s+not\s+(?:just|merely|only|simply)\s+(?:about\s+)?[^.;]{2,60}?[,—-]\s*(?:it'?s|this is|that'?s|they'?re)\b/i),
  },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function getRule(id) {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// suppression pragmas
// ---------------------------------------------------------------------------

const PRAGMA = /slop-ok(?::\s*([\w-]+(?:\s*,\s*[\w-]+)*))?/;

/**
 * Map of lineNumber -> Set of suppressed ruleIds ('*' for a bare pragma, which
 * suppresses nothing and reports itself instead).
 * A pragma covers its own line and the line immediately below it — no further.
 */
export function pragmaMap(lines, lang = 'unknown') {
  const map = new Map();
  const bare = [];
  lines.forEach((text, i) => {
    // Only inside a comment. Otherwise prose that merely mentions the pragma,
    // or a string literal containing it, would suppress real findings.
    const comment = commentText(text, lang);
    if (comment === null) return;
    const m = comment.match(PRAGMA);
    if (!m) return;
    const n = i + 1;
    if (!m[1]) {
      bare.push(n);
      return;
    }
    const ids = new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
    for (const target of [n, n + 1]) {
      const existing = map.get(target) ?? new Set();
      ids.forEach((id) => existing.add(id));
      map.set(target, existing);
    }
  });
  return { map, bare };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { block: 0, warn: 1 };

class UnknownRuleError extends Error {}
export { UnknownRuleError };

// Per-rule options a repo may override, with the defaults that stay in force when
// it doesn't. A threshold is only tunable if it appears here.
export const RULE_OPTIONS = {
  'commit-subject-too-long': { max: MAX_SUBJECT_LEN },
  'comment-density': { minComments: MIN_DENSITY_COMMENTS, minCode: MIN_DENSITY_CODE },
};

/**
 * Normalises a config value to {severity, ...opts}. Both forms are accepted:
 *
 *   "comment-density": "warn"
 *   "comment-density": { "severity": "warn", "minComments": 10 }
 *
 * Every consumer MUST read severity through this, never off the raw value —
 * a site that still string-compares would silently ignore the object form.
 */
function normalizeEntry(id, value, source) {
  const raw = typeof value === 'string' ? { severity: value } : { ...value };
  const { severity, ...opts } = raw;
  if (severity !== undefined && !['off', 'warn', 'block'].includes(severity)) {
    throw new UnknownRuleError(`${source}: rule "${id}" has level "${severity}"; expected "off", "warn" or "block".`);
  }
  const allowed = RULE_OPTIONS[id] ?? {};
  for (const [k, v] of Object.entries(opts)) {
    if (!(k in allowed)) {
      const known = Object.keys(allowed);
      throw new UnknownRuleError(
        `${source}: rule "${id}" has no option "${k}". ${known.length ? `Known options: ${known.join(', ')}.` : 'It takes no options.'}`
      );
    }
    if (!Number.isInteger(v) || v < 1) {
      throw new UnknownRuleError(`${source}: rule "${id}" option "${k}" must be a positive integer (got ${JSON.stringify(v)}).`);
    }
  }
  // Only what was actually written, and `severity` is OMITTED rather than set to
  // undefined when absent — an explicit undefined would spread over and erase a
  // parent .no-slop.json's severity during the per-key merge. Defaults are applied
  // at read time by ruleOptions() for the same reason.
  return { ...(severity === undefined ? {} : { severity }), ...opts };
}

/** Throws on an unknown ruleId, bad severity, or unknown option — config errors must be loud. */
export function validateConfig(config, source = '.no-slop.json') {
  const out = {};
  for (const [id, value] of Object.entries(config ?? {})) {
    if (!BY_ID.has(id)) {
      throw new UnknownRuleError(`${source}: unknown rule id "${id}". Known ids: ${RULES.map((r) => r.id).join(', ')}`);
    }
    if (value !== null && typeof value === 'object' && Array.isArray(value)) {
      throw new UnknownRuleError(`${source}: rule "${id}" must be a severity string or an options object, not an array.`);
    }
    out[id] = normalizeEntry(id, value, source);
  }
  return out;
}

/** Resolved options for a rule: repo overrides on top of the built-in defaults. */
export function ruleOptions(id, config = {}) {
  return { ...(RULE_OPTIONS[id] ?? {}), ...(config[id] ?? {}) };
}

/**
 * Blanks the interior of every fenced block, IN PLACE.
 *
 * In place, not spliced: findings are keyed `line:ruleId` in .no-slop-baseline.json
 * and several rules index ctx.lines directly, so removing lines would shift every
 * subsequent number and silently invalidate every .md entry in an existing baseline.
 *
 * Side effect, deliberate: a suppression pragma written inside a fence no longer
 * registers. It was suppressing findings that can no longer occur.
 */
function blankFenceInteriors(lines) {
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence === null) {
      if (m) fence = m[1];
      continue;
    }
    // A closer must use the same character and be at least as long as the opener,
    // so ``` inside a ```` block does not end it early.
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
      fence = null;
      continue;
    }
    lines[i] = '';
  }
  return lines;
}

/**
 * Walk brace-delimited test bodies. Bounded so a minified fixture cannot make
 * this quadratic; on overrun the caller gets a truncation signal instead.
 */
function collectTestBodies(lines) {
  const bodies = [];
  let overran = false;
  const opener = /\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(opener);
    if (!m) continue;
    // depth 0 means "directly inside the opening brace"; the `}` that closes
    // the body is the first one seen at depth 0.
    let depth = 0;
    let closed = false;
    let end = i;
    const body = [];
    const limit = Math.min(lines.length, i + MAX_BRACE_SCAN_LINES);
    for (let j = i; j < limit && !closed; j++) {
      const from = j === i ? m.index + m[0].length : 0;
      const segment = lines[j].slice(from);
      let k = 0;
      for (; k < segment.length; k++) {
        const ch = segment[k];
        if (ch === '{') depth++;
        else if (ch === '}') {
          if (depth === 0) { closed = true; break; }
          depth--;
        }
      }
      body.push(segment.slice(0, k));
      end = j;
    }
    if (!closed) { overran = true; continue; }
    const text = body.join('\n');
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('')
      .replace(/[{}\s;]/g, '');
    bodies.push({
      line: i + 1,
      endLine: end + 1,
      title: m[2],
      text,
      empty: stripped === '',
      hasAssertion: /\b(?:expect|assert|should|verify|\.to\.|chai)\b/.test(text),
    });
    i = end;
  }
  return { bodies, overran };
}

/**
 * @param {string} text
 * @param {{lang?:string, ruleClasses:Set<string>|string[], config?:object, budgetMs?:number, now?:()=>number}} opts
 */
export function scan(text, opts = {}) {
  const {
    lang = 'unknown',
    config = {},
    budgetMs = 200,
    now = () => Date.now(),
  } = opts;
  const classes = opts.ruleClasses instanceof Set ? opts.ruleClasses : new Set(opts.ruleClasses ?? []);
  const resolved = validateConfig(config);

  const lines = text.split('\n');
  const findings = [];
  let truncated = null;

  // Global size gate: one WARN, no rules. A hook that stalls gets uninstalled.
  if (lines.length > MAX_FILE_LINES || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return {
      findings: [{
        ruleId: 'file-too-large',
        severity: 'warn',
        line: 1,
        excerpt: `${lines.length} lines`,
        message: `File exceeds the scan gate (${MAX_FILE_LINES} lines / ${MAX_FILE_BYTES} bytes); no rules were run.`,
        fix: 'Split the file, or add it to the path excludes if it is generated.',
      }],
      truncated: null,
    };
  }

  // A fenced block in markdown is an illustration, not shipped code, but the scanner
  // reads .md line-by-line as prose — so comment AND naming rules fire on sample
  // snippets. (Verified: a fence containing `const EnhancedParser = 1` trips
  // naming-inflated, so gating only the comment rules would leave half the bug live.)
  if (lang === 'md') blankFenceInteriors(lines);

  const { map: pragmas, bare: barePragmas } = pragmaMap(lines, lang);
  const start = now();
  let lastLine = lines.length;

  const codeLines = function* () {
    for (let i = 0; i < lines.length; i++) {
      if (i % 500 === 0 && now() - start > budgetMs) {
        truncated = i + 1;
        lastLine = i;
        return;
      }
      const text = lines[i];
      if (text.length > MAX_LINE_LEN) continue;
      yield { n: i + 1, text };
    }
  };

  let bodiesCache = null;
  const ctx = {
    lang,
    classes,
    lines,
    codeLines,
    isTrailer: (l) => /^(?:Co-Authored-By|Claude-Session|Signed-off-by|Reviewed-by|Tested-by|Acked-by|Cc|Fixes|Refs):/i.test(l.trim()),
    testBodies: () => {
      if (!bodiesCache) {
        const r = collectTestBodies(lines);
        bodiesCache = r.bodies;
        if (r.overran) truncated = truncated ?? lastLine;
      }
      return bodiesCache;
    },
  };

  for (const rule of RULES) {
    const level = resolved[rule.id]?.severity;
    if (level === 'off') continue;
    if (resolved[rule.id] === undefined && rule.enabled === false) continue;
    if (!rule.classes.some((c) => classes.has(c))) continue;
    const severity = level === 'warn' || level === 'block' ? level : rule.severity;
    ctx.options = ruleOptions(rule.id, resolved);
    for (const hit of rule.match(ctx)) {
      const suppressed = pragmas.get(hit.line);
      if (suppressed?.has(rule.id)) continue;
      findings.push({
        ruleId: rule.id,
        severity,
        line: hit.line,
        excerpt: hit.excerpt,
        message: rule.message,
        fix: rule.fix,
      });
    }
  }

  for (const line of barePragmas) {
    findings.push({
      ruleId: 'pragma-bare',
      severity: 'warn',
      line,
      excerpt: 'slop-ok',
      message: 'Bare "slop-ok" suppresses nothing — a pragma must name the rule it silences.',
      fix: 'Write the rule id: // slop-ok: naming-vague-generic',
    });
  }

  const seen = new Set();
  const deduped = findings.filter((f) => {
    const key = `${f.line} ${f.ruleId} ${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) =>
    a.line - b.line ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.ruleId.localeCompare(b.ruleId));

  return { findings: deduped, truncated };
}
