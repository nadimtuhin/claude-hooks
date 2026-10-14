# claude-hooks

Four hooks for [Claude Code](https://claude.com/claude-code). No plugins, no npm
dependencies — Node stdlib, `jq`, and `git`.

The main one is **no-slop**: a scanner that catches mechanical AI slop in code
comments, commit messages, test bodies, and the model's own prose, at the moment
it is written.

It runs as a dependency-free Node script, or as an optional Go binary with the
same rules and exit codes, held to parity by a differential harness in CI. The
Go binary takes about 15ms per hook call against Node's 50ms, and no-slop runs
up to three times per turn.

---

## What no-slop is, and is not

**It is a tripwire, not a detector.** It catches the laziest mechanical tells —
verbatim provenance phrases, empty test bodies, self-comparison tautologies,
commit filler words, reflexive agreement openers. It is a floor, not a ceiling.

We know the ceiling because we measured it. Ten realistic slop samples were
written specifically to dodge these rules — narration comments that restate
loops in prose, an `EnhancedPipeline` renamed to `buildRobustPipeline`, a test
that wraps everything in `try/catch` and asserts `expect(true).toBeTruthy()`.
**All ten passed clean** before we tightened one of them.

That is expected behaviour, not a bug to chase. Regex and wordlists have a hard
detection ceiling; paraphrase walks straight past them. Chasing recall costs
precision, and a linter that cries wolf gets uninstalled inside a week. So the
rules stay narrow and the false-positive rate stays near zero:

| Corpus | Result |
|---|---|
| ~1,300 source files in a large private repo | 26 findings, **1 BLOCK** (a genuine `expect(true).toBe(true)`) |
| 300 real commit messages from that repo | 17 findings, all subject-length or filler |
| 10 adversarial dodge samples | 0 caught |

If you want real slop detection, you want a reviewer — human or model. This is
the cheap deterministic layer underneath that, for the tells a regex genuinely
can catch.

---

## Install

```sh
git clone https://github.com/nadimtuhin/claude-hooks
cd claude-hooks
./install.sh
```

Then restart Claude Code — hooks are read at session start.

### Optional: the Go binary

Needs Go 1.26 or newer. Build it once, and again after every `git pull`, since
the binary is not committed:

```sh
cd hooks/no-slop/go && go build -o no-slop .
```

Then point the three no-slop entries in `~/.claude/settings.json` at it, keeping
Node as the fallback so a missing binary never disables the hook:

```sh
if [ -x "$DIR/hooks/no-slop/go/no-slop" ]; then "$DIR/hooks/no-slop/go/no-slop" write; else node "$DIR/hooks/no-slop/hook.mjs" write; fi
```

Same for `commit` and `turn`, with `$DIR` replaced by the path of this
checkout. The binary also takes `scan` and `baseline` with the same flags as
`hook.mjs`.

On an existing codebase, snapshot what is already there so you only ever see
**new** findings:

```sh
node hooks/no-slop/hook.mjs baseline .
```

Without that step, installing on a large repo means an unbounded first-run hit
count, which is how a linter gets disabled rule by rule.

Uninstall with `./uninstall.sh`. Both scripts back up `settings.json` first, only
touch entries tagged `_source: "claude-hooks"` pointing at this checkout, and
abort if `settings.json` changes underneath them.

**If you already register any of these hooks by hand**, remove your manual
entries first. The installer cannot tell that your untagged
`~/.claude/hooks/verify-edit.sh` entry is the same hook as its own, so you would
get both.

---

## The hooks

| Hook | Event | What it does |
|---|---|---|
| `no-slop/hook.mjs write` | `PostToolUse` on `Write\|Edit` | Scans the file just written. |
| `no-slop/hook.mjs commit` | `PreToolUse` on `Bash` | Blocks a `git commit` with a sloppy message. |
| `no-slop/hook.mjs turn` | `Stop` | Advisory check on the model's own prose. |
| `verify-edit.sh` | `PostToolUse` on `Write\|Edit` | Syntax/lint check on just the edited file, using whatever is already installed. |
| `engineering-discipline.sh` | `UserPromptSubmit` | Injects standing engineering directives, only on build/plan prompts. |
| `optimize-claude-md.sh` | — | Archives `CLAUDE.md` past 400 lines. **Not registered by default**; add it yourself if you want it. |

### `write` mode cannot prevent anything

`PostToolUse` fires *after* the write lands. A BLOCK finding there does not stop
the edit — the file is already on disk. It surfaces the finding so the model
makes a follow-up edit. Spelled out because it is easy to assume otherwise.

`commit` mode is the one that genuinely prevents: it runs on `PreToolUse` and
aborts the commit, routing the reason back for a rewrite. It passes silently
when the message is not visible on the command line (`-F`, `--template`, bare
`git commit`) — a gate that cannot see its input must not block. `Co-Authored-By:`
and `Claude-Session:` trailers are exempt.

`turn` mode always exits 0. It only ever advises.

---

## Rules

32 rules in six classes. A rule runs only when its class is in scope: a file
write gets `comment` + `naming` + `style`, plus `testfile` if the path looks
like a test; a commit gets `commit`; a turn gets `prose`. That is two axes
deliberately — a test file is both a test file and a code file, and commit
text is not prose.

**9 BLOCK** — objective, convention-based, near-zero judgement:

| Rule | Fires on |
|---|---|
| `comment-provenance` | `// as you requested`, `// per your review feedback` — with no ticket ref on the line |
| `testfile-unconditional-skip` | `it.skip('...')`, `xit(...)` — the conditional `test.skip(cond, reason)` form is ignored |
| `testfile-only` | `.only`, `fit`, `fdescribe` |
| `testfile-empty-body` | `it('x', () => {})` |
| `testfile-tautology` | `expect(x).toBe(x)`, `expect(true).toBeTruthy()` |
| `commit-subject-too-long` | subject over 100 chars |
| `commit-subject-trailing-period` | subject ending in `.` |
<!-- slop-ok: marketing-superlative -->
| `marketing-superlative` | `best-in-class`, `cutting-edge`, `bulletproof` |
| `prose-opener` | `You're absolutely right`, `Great question!` |

**23 WARN** — everything else: comment narration, restated code, decorative
banners, comment density, duplicate test bodies, inflated and doubled-role
identifiers, tests with no assertions or vague titles, commit filler and body
narration, prose vocabulary tells, not-just-X-it's-Y constructions, nested
ternaries, and the section sign (legal-citation punctuation nobody hand-types
in engineering notes; a quoted one is spared, so masked string literals stay
clean).

| Rule | Fires on |
|---|---|
| `style-nested-ternary` | `a ? b ? 1 : 2 : 3` — a ternary inside another ternary's branch; a single ternary stays quiet |

Markdown files are scanned with the `prose` class as well as `comment` and
`naming` — a `.md` body is prose, so the rhetorical tells apply there and not
only to chat output.

`comment-density` fires when a file has more comment lines than code lines (and
at least 6 comments and 10 code lines — both floors matter, because a one-function
module whose header explains the trap it exists for clears the comment floor on
that header alone, and the only edit that gets it under the ratio is deleting the
explanation). Its finding lists the line numbers it counted, so the cheap
way to comply is deleting narration rather than whichever comment is longest —
which is systematically the one documenting a trap. Markdown, shell and test
files are exempt: a high ratio is the convention in all three.

`testfile-duplicate-body` fires when two or more tests have the same body once
string and numeric literals are masked — the shape that wants `it.each`. It
reports **one** finding per group, at the first member, listing the sibling lines;
per-hit reporting would let a single 4-way duplicate consume the whole warn cap.
Bodies under three lines are skipped, or every `expect(x).toBe(1)` one-liner
pairs up. It is blind to existing `it.each` tables by construction — the body
walker only opens on a quoted title — so it can push code towards tables but can
never complain about one.

**Markdown is read as prose, not code.** Fenced blocks are blanked before any rule
runs (in place, so line numbers and therefore baseline keys never shift), and `#`,
`*` and `--` are treated as headings and list items rather than comment openers.
Without both, every README heading and every illustrative snippet in a design doc
trips the comment and naming rules. An HTML comment (`<!-- -->`) in markdown is
still a comment and is still scanned.

Every rule carries a `fix` string with a concrete replacement, not a scolding.

### Deliberately absent

- **`prose-hedge-stack`** — honest writing about race conditions double-hedges
  constantly. Highest false-positive risk in the set; dropped.
- **`crucial` / `pivotal` / `underscore` / `landscape`** — dropped from the
  vocabulary tells. Closed wordlists misfire from both directions: too narrow to
  catch paraphrase, too broad on legitimate ESL formal register.
- **`naming-vague-generic`** ships **off by default**. It never got an
  adversarial pass. Turn it on with `{"rules": {"naming-vague-generic": "warn"}}`.

A WARN should read as "this is rhetorical repetition", never as "your English is
wrong". If one reads the second way, that is a bug — please open an issue.

---

## Configuration

`.no-slop.json`, resolved from the file's directory up to the git root, leaf wins:

```json
{ "rules": { "comment-restates-code": "off", "naming-doubled-role": "block" } }
```

Levels are `off`, `warn`, `block`. **An unparseable file or an unknown rule id is
a hard error naming the file** — never a silent skip. The worst failure mode for
a linter is not crashing, it is running and catching nothing while you believe it
is working.

### Rule thresholds

A rule with a tunable threshold also accepts an object. The string form keeps
working unchanged; the two are merged per key across nested files, so a leaf that
sets only a threshold does not drop a severity the parent set.

```json
{ "rules": { "commit-subject-too-long": { "severity": "warn", "max": 72 } } }
```

| Rule | Option | Default |
| --- | --- | --- |
| `commit-subject-too-long` | `max` | `100` |
| `comment-density` | `minComments` | `6` |
| `comment-density` | `minCode` | `10` |

The subject-length default is 100, not the conventional 72, on measurement: over
300 real commits, 72 fired 151 times and 100 fired 18. A gate that stops half of
all commits gets switched off within a week, which costs more than it saves — so
a repo that wants 72 opts into it rather than having it imposed. An unknown option
name, or a threshold that is not a positive integer, is the same hard error as an
unknown rule id.

### Suppressing one finding

```js
// slop-ok: naming-inflated
class EnhancedParser {}
```

The pragma covers its own line and the one immediately below — no further. It
must name a rule: a bare `slop-ok` parses, suppresses nothing, and reports
itself, rather than silently disabling every rule forever including ones added
years later.

For a span, or for a line you cannot put a comment beside:

```js
// no-slop-disable-next-line naming-inflated
class EnhancedParser {}

/* no-slop-disable comment-narration-generic-steps */
// ...generated or vendored block...
/* no-slop-enable comment-narration-generic-steps */
```

`*` in place of a rule id covers every rule. A `no-slop-disable` with no
matching `no-slop-enable` runs to the end of the file on purpose: a forgotten
enable is the bug, and quietly ending the span early would hide slop nobody
meant to exempt.

### Baseline

`no-slop baseline .` writes `.no-slop-baseline.json` with every current
`(file, line, ruleId)`, and those stop being reported. New findings still fire.
Commit the file so your team shares one baseline.

---

## CLI

```sh
node hooks/no-slop/hook.mjs scan src/                  # scan a tree
node hooks/no-slop/hook.mjs scan src/ --severity=block  # blocks only
node hooks/no-slop/hook.mjs scan file.ts --all          # no output cap
node hooks/no-slop/hook.mjs scan README.md --prose      # prose rules on a doc
git log -300 --format=%B%x00 | node hooks/no-slop/hook.mjs scan --stdin --commit
```

`--format=%B%x00` matters: a commit body can contain blank lines, so `%B` alone
has no unambiguous message boundary. Without a NUL separator the scanner treats
stdin as one message and tells you so, rather than guessing and reporting line
numbers against the wrong commit.

Exit codes: `scan` returns 1 if anything was found at or above `--severity`.

Write mode caps output at every BLOCK plus three WARNs, then `+N more`. 23 of 32
rules are WARN; uncapped output reads as "complains about everything".

---

## Limits

- **Regex, not parsing.** Comment detection is heuristic. A `#` inside a JS
  template literal is handled; more exotic cases will not be.
- **Size gates.** Files over 1500 lines or 150 KB emit one WARN and run no
  rules. Lines over 2000 chars are skipped. `dist/`, `build/`, `*.min.*`,
  `node_modules/`, lockfiles are never scanned. Scanning ~1,300 files takes
  about a second.
- **Detection ceiling.** See the table at the top. Slop that reads naturally
  passes.
- **Whole files, not diffs.** The scanner never sees a diff, so `comment-density`
  measures a file's overall density rather than "this edit added more comments
  than code" — a weaker signal, but one that needs no new architecture. Use
  `no-slop baseline .` to grandfather files that are historically comment-heavy.
- **`commit` mode reads the commit message, not the staged diff.** It cannot
  block a commit for what the code contains, only for how the message reads.
- **Commit detection is a tokenizer, not a shell.** `git -C <dir> commit`, a
  `cd` prefix, an `rtk git` rewrite and heredoc messages are all handled; a
  commit command that only appears inside a quoted string is not distinguished
  from a real one.

---

## Development

```sh
make test        # unit tests, no container, no key
make e2e         # tier 1 in Alpine/musl — deterministic, no key. The CI gate.
make e2e-host    # the same tier-1 assertions on your host, without Docker
make e2e-live    # tier 2: drives a real headless session. Needs ANTHROPIC_API_KEY.
make go-test     # Go port: vet + unit tests
make parity      # build the Go binary, diff its findings and CLI output against hook.mjs
make e2e-host-go # tier-1 assertions against the Go binary
```

**Parity** — `hook.mjs` is the reference. `parity/harness.mjs` runs both
implementations over the fixtures (plus any local repos and transcripts you
point it at), diffs every finding, and fails if any rule id has zero findings
in the corpus, so an untested rule cannot pass by matching nothing.
`parity/cli-replay.mjs` diffs exit codes and output for 500 hook payloads.
Any rule change lands in both files and passes `make parity`.

**Unit tests** — 372 of them, no dependencies. `slop-rules.mjs` is pure (no I/O, no
`process`), so every rule is testable without a filesystem. `hook.mjs` owns all
I/O and is tested through subprocesses, because a bad `tool_input` path or a
config file that silently disables everything is exactly what unit tests on
pure functions cannot catch.

**Tier 1** proves the scripts behave: exit codes per mode, config failing loud,
the baseline round-trip, install being idempotent, and uninstall restoring
`settings.json` byte-for-byte. It runs in `node:22-alpine` because that is where
the interesting failures live — BusyBox `ash` cannot run the bash hooks, and the
ripgrep bundled with claude-code is glibc-linked and fails on musl as a *silent
empty search* rather than a crash. The image installs the musl build and asserts
`rg` works instead of assuming it.

**Tier 2** is the only thing that proves `settings.json` registration actually
causes a hook to fire. It makes two deliberately separate assertions: a sentinel
wrapper writes a file (the event fired at all), and `git log` count is unchanged
(the logic prevented the commit). Sentinel-only failure is a wiring bug;
block-only failure is a rule bug — one combined assertion could not tell you
which. Model behaviour is nondeterministic, so it retries a bounded number of
times and is nightly/on-demand, never a required gate.

---

## Companion

[**claude-code-self-critic**](https://github.com/nadimtuhin/claude-code-self-critic)
— a Stop-hook fact gate that blocks turns making claims the transcript does not
back up, plus a stuck-loop detector. Different problem, same shape. Installed
separately.

## License

MIT
