package main

// Code generated from slop-rules.mjs RULES (id, classes, severity, enabled, message, fix). DO NOT EDIT.
type ruleMeta struct {
	id         string
	classes    []string
	severity   string
	offDefault bool
	message    string
	fix        string
}

var ruleMetas = []ruleMeta{
	{id: "comment-provenance", classes: []string{"comment"}, severity: "block", offDefault: false, message: "Comment records why the edit was made, not what the code means.", fix: "Delete the line. If the reason matters, state the invariant instead: \"// callers may pass null; the guard below is load-bearing\"."},
	{id: "comment-provenance-ticketed", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Provenance comment carrying a ticket reference.", fix: "Keep the ticket link, drop the narration: \"// see #412\" rather than \"// changed per review, see #412\"."},
	{id: "comment-changelog-reference", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Comment narrates repo history (a ticket, a past bug, \"used to\"/\"previously\") instead of stating the invariant.", fix: "Rewrite as the current invariant and drop the reference: \"release the lock only after the drain completes\", not \"TASK-35: release the lock only after...\"."},
	{id: "comment-duplicate-adjacent", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Two adjacent comment paragraphs restate the same fact — the classic residue of a new explanation prepended without deleting the stale one.", fix: "Delete whichever paragraph is wrong or stale; keep one explanation."},
	{id: "comment-narration-generic-steps", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Sequential step narration (\"Step 1 / First / Then / Finally\") walking the reader through code they can already read.", fix: "Delete the markers. If the sequence is genuinely non-obvious, name the phases as functions instead."},
	{id: "comment-restates-code", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Comment restates the line below it in English.", fix: "Delete it. A comment earns its place by saying WHY, or naming an invariant the code cannot express."},
	{id: "comment-section-banner", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Decorative ASCII banner comment.", fix: "Delete the rule line. If the file needs sections that badly, split the file."},
	{id: "comment-obvious-label", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "Comment labels a construct the syntax already names.", fix: "Delete it — \"// Constructor\" above a constructor tells the reader nothing."},
	{id: "comment-density", classes: []string{"comment"}, severity: "warn", offDefault: false, message: "File has more comment lines than code lines.", fix: "Delete the comments that restate the code. Keep the ones naming a trap or a non-obvious why — those are the shortest path back under the line, not the longest."},
	{id: "naming-inflated", classes: []string{"naming"}, severity: "warn", offDefault: false, message: "Identifier opens with a self-congratulatory adjective.", fix: "Name what it does, not how good it is: EnhancedParser → StreamingParser, SmartCache → LruCache."},
	{id: "naming-doubled-role", classes: []string{"naming"}, severity: "warn", offDefault: false, message: "Identifier stacks two role suffixes.", fix: "Keep one: ProfileManagerService → ProfileStore. If both roles are real, it is two types."},
	{id: "naming-versioned-suffix", classes: []string{"naming"}, severity: "warn", offDefault: false, message: "Identifier versioned by suffix instead of by replacing the old one.", fix: "Delete the old definition and keep the plain name: parseConfigV2 → parseConfig."},
	{id: "naming-redundant-type-suffix", classes: []string{"naming"}, severity: "warn", offDefault: false, message: "Identifier repeats its own type in the name.", fix: "Drop the suffix: userObject → user, nameString → name. The type annotation already says it."},
	{id: "naming-vague-generic", classes: []string{"naming"}, severity: "warn", offDefault: true, message: "Identifier is a placeholder rather than a name.", fix: "Say what it holds or does: processData → normalizeInvoiceRows, helper → formatCurrency."},
	{id: "style-nested-ternary", classes: []string{"style"}, severity: "warn", offDefault: false, message: "Nested ternary — a ternary inside another ternary's branch reads left-to-right but evaluates outside-in.", fix: "Rewrite as if/else, or extract each branch into a named function."},
	{id: "testfile-unconditional-skip", classes: []string{"testfile"}, severity: "block", offDefault: false, message: "Test is skipped unconditionally.", fix: "Delete the test or make it pass. For a genuinely conditional skip use the runtime form — test.skip(isCI, \"reason\") — which this rule ignores."},
	{id: "testfile-only", classes: []string{"testfile"}, severity: "block", offDefault: false, message: "Focused test will silently skip the rest of the suite.", fix: "Remove .only before committing."},
	{id: "testfile-empty-body", classes: []string{"testfile"}, severity: "block", offDefault: false, message: "Test body is empty — it passes without asserting anything.", fix: "Write the assertion, or delete the case. An always-green test is worse than no test."},
	{id: "testfile-no-assertions", classes: []string{"testfile"}, severity: "warn", offDefault: false, message: "Test body has statements but no assertion.", fix: "Add the expect/assert that would fail if the behaviour broke."},
	{id: "testfile-tautology", classes: []string{"testfile"}, severity: "block", offDefault: false, message: "Assertion compares a value to itself and can never fail.", fix: "Assert against the expected literal, not against the same expression."},
	{id: "testfile-vague-name", classes: []string{"testfile"}, severity: "warn", offDefault: false, message: "Test title does not say what behaviour is expected.", fix: "Name the behaviour and the condition: \"returns 404 when the id is unknown\"."},
	{id: "testfile-duplicate-body", classes: []string{"testfile"}, severity: "warn", offDefault: false, message: "Two or more tests have the same body apart from their literals.", fix: "Collapse into it.each over the varying literal. Keep the titles distinct in the table or a failure stops naming which case broke."},
	{id: "commit-subject-too-long", classes: []string{"commit"}, severity: "block", offDefault: false, message: "Commit subject is over the configured length limit.", fix: "Trim the subject to the change itself and move the detail to the body after a blank line. 72 is the convention worth aiming at."},
	{id: "commit-subject-trailing-period", classes: []string{"commit"}, severity: "block", offDefault: false, message: "Commit subject ends with a period.", fix: "Drop the final period — the subject is a title, not a sentence."},
	{id: "commit-filler", classes: []string{"commit"}, severity: "warn", offDefault: false, message: "Commit subject says a change happened without saying what changed.", fix: "Name the behaviour: \"fix null deref when the profile lock is stale\"."},
	{id: "commit-provenance", classes: []string{"commit"}, severity: "warn", offDefault: false, message: "Commit message narrates the review conversation rather than the change.", fix: "Describe the code change; the review thread already records the discussion."},
	{id: "commit-body-narration", classes: []string{"commit"}, severity: "warn", offDefault: false, message: "Commit body opens with a meta-heading instead of the change.", fix: "Delete the heading and start with the change: bullet the behaviour differences directly."},
	{id: "marketing-superlative", classes: []string{"commit", "prose"}, severity: "block", offDefault: false, message: "Marketing superlative in engineering text.", fix: "State the measurable claim instead: \"cutting-edge parser\" → \"handles streaming input without buffering\"."},
	{id: "prose-opener", classes: []string{"prose"}, severity: "block", offDefault: false, message: "Reflexive agreement/flattery opener.", fix: "Delete the opener and start with the answer."},
	{id: "prose-vocabulary-tells", classes: []string{"prose"}, severity: "warn", offDefault: false, message: "Rhetorical filler vocabulary — reads as padding rather than information.", fix: "Swap for the plain verb: delve → look into, leverage → use, seamless → without extra setup, myriad of → many."},
	{id: "prose-section-sign", classes: []string{"prose", "comment"}, severity: "warn", offDefault: false, message: "Section sign (§) — legal-citation punctuation almost nobody types by hand in engineering notes.", fix: "Write it out: \"§7\" → \"section 7\", or link the heading. In a code fence, quote it."},
	{id: "prose-negative-parallelism", classes: []string{"prose"}, severity: "warn", offDefault: false, message: "Not-just-X-it's-Y construction — rhetorical shape carrying no extra information.", fix: "Keep only the positive half: say what it is and drop the \"not just\" clause."},
}
