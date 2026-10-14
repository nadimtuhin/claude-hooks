#!/usr/bin/env node
// no-slop — argv dispatch for the slop scanner.
//
//   hook.mjs write      PostToolUse  Write|Edit   exit 2 on any finding (surfaces it; cannot prevent)
//   hook.mjs commit     PreToolUse   Bash         exit 2 on BLOCK (real prevention)
//   hook.mjs turn       Stop                      advisory, always exit 0
//   hook.mjs scan       CLI                       exit 1 if findings at/above --severity
//   hook.mjs baseline   CLI                       snapshot current findings, suppress them thereafter
//
// The write hook runs AFTER the write has landed. It cannot stop anything; it
// reports the finding so the model makes a follow-up edit. Two reviewers read
// it as prevention, so it is spelled out here and in the README.

import fs from 'node:fs';
import path from 'node:path';
import { scan, validateConfig, UnknownRuleError, RULE_CLASSES } from './slop-rules.mjs';

const BASELINE_FILE = '.no-slop-baseline.json';
const CONFIG_FILE = '.no-slop.json';
const WARN_CAP = 3;

const EXCLUDED_DIR = /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|generated|\.git|\.next|target)(?:\/|$)|\/tmp\/claude-[^/]+\/.*\/scratchpad\//;
const EXCLUDED_FILE = /\.min\.[a-z]+$|\.(?:lock|map|snap)$|-lock\.(?:json|ya?ml)$/;
const SCANNABLE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|sh|bash|c|h|cc|cpp|hpp|cs|scala|sql|md)$/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$|test_[^/]+\.py$/;

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function die(message) {
  process.stderr.write(`no-slop: ${message}\n`);
  process.exit(1);
}

function repoRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Merge every .no-slop.json from the repo root down to `dir`, leaf wins.
 * A malformed file or an unknown rule id is a hard error naming the file — a
 * linter that silently disables itself is worse than no linter.
 */
function loadConfig(dir) {
  const start = path.resolve(dir);
  const root = repoRoot(start);
  const chain = [];
  let cur = start;
  for (;;) {
    chain.unshift(cur);
    if (root && cur === root) break;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  let merged = {};
  for (const d of chain) {
    const file = path.join(d, CONFIG_FILE);
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      die(`${file}: not valid JSON (${err.message})`);
    }
    if (parsed.rules === undefined || typeof parsed.rules !== 'object' || parsed.rules === null) {
      die(`${file}: expected a top-level "rules" object, e.g. {"rules":{"naming-inflated":"off"}}`);
    }
    let normalized;
    try {
      normalized = validateConfig(parsed.rules, file);
    } catch (err) {
      if (err instanceof UnknownRuleError) die(err.message);
      throw err;
    }
    // Per-key merge, not wholesale replace: a leaf that sets only a threshold must
    // not silently drop a severity the parent set for the same rule.
    for (const [id, entry] of Object.entries(normalized)) {
      merged[id] = { ...(merged[id] ?? {}), ...entry };
    }
  }
  return merged;
}

/**
 * Nearest .no-slop-baseline.json at or above `from`, with the directory it sits
 * in — baseline keys are relative to that. Deliberately independent of .git: a
 * baseline must work in a directory that is not a git repo yet.
 * @returns {{dir: string, data: object} | null}
 */
function findBaseline(from) {
  let dir = path.resolve(from);
  for (;;) {
    const file = path.join(dir, BASELINE_FILE);
    if (fs.existsSync(file)) {
      try {
        return { dir, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        die(`${file}: not valid JSON (${err.message}). Delete it or re-run "no-slop baseline".`);
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const baselineKey = (f) => `${f.line}:${f.ruleId}`;

function applyBaseline(findings, baseline, absPath) {
  if (!baseline) return findings;
  const known = new Set(baseline.data.findings?.[path.relative(baseline.dir, absPath)] ?? []);
  return findings.filter((f) => !known.has(baselineKey(f)));
}

// ---------------------------------------------------------------------------
// scanning a file on disk
// ---------------------------------------------------------------------------

export function isExcluded(p) {
  return EXCLUDED_DIR.test(p) || EXCLUDED_FILE.test(path.basename(p));
}

function classesFor(filePath) {
  const set = new Set(['comment', 'naming', 'style']);
  if (TEST_PATH.test(filePath)) set.add('testfile');
  if (/\.mdx?$/i.test(filePath)) set.add('prose');
  return set;
}

/**
 * Inline suppression directives, three forms:
 *   // no-slop-disable-next-line <rule>        suppresses one line
 *   /* no-slop-disable <rule>   ...  /* no-slop-enable <rule> * /
 * Bare `no-slop-disable` without a rule id means "all rules" for its span.
 * @returns {Array<{ruleId: string, line: number, endLine: number}>}
 */
function findDisableDirectives(lines) {
  const directives = [];
  let activeBlock = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = line.match(/no-slop-disable-next-line\s+(\*|\S+)/);
    if (next) {
      directives.push({ ruleId: next[1].trim(), line: i + 2, endLine: i + 2 });
      continue;
    }
    const off = line.match(/no-slop-disable\s+(\*|\S+)/);
    if (off) {
      activeBlock = { ruleId: off[1].trim(), startLine: i + 1 };
      continue;
    }
    if (activeBlock && /no-slop-enable\b/.test(line)) {
      directives.push({ ruleId: activeBlock.ruleId, line: activeBlock.startLine, endLine: i + 1 });
      activeBlock = null;
    }
  }
  // Unclosed block runs to EOF — intentional. A forgetten enable is the bug here,
  // and silently narrowing the span would hide slop the author did not exempt.
  if (activeBlock) {
    directives.push({ ruleId: activeBlock.ruleId, line: activeBlock.startLine, endLine: lines.length });
  }
  return directives;
}

/** True when `line` (1-based) sits inside a directive matching `ruleId` (or the wildcard "*"). */
function isSuppressed(directives, ruleId, line) {
  return directives.some(
    (d) =>
      (d.ruleId === '*' || d.ruleId === ruleId) &&
      line >= d.line &&
      line <= d.endLine
  );
}

function scanFile(filePath, { config, extraClasses } = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const classes = extraClasses ?? classesFor(filePath);
  const cfg = config ?? loadConfig(path.dirname(filePath));
  const { findings } = scan(text, {
    lang: path.extname(filePath).replace('.', '') || 'unknown',
    ruleClasses: classes,
    config: cfg,
  });
  const directives = findDisableDirectives(text.split('\n'));
  return {
    findings: directives.length
      ? findings.filter((f) => !isSuppressed(directives, f.ruleId, f.line))
      : findings,
  };
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (isExcluded(p)) continue;
    if (e.isDirectory()) yield* walk(p);
    else if (SCANNABLE.test(e.name)) yield p;
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function render(findings, { file, cap } = {}) {
  const loc = (f) => `${file ? `${file}:` : 'line '}${f.line}`;
  return findings
    .map((f) => [
      `  [${f.severity.toUpperCase()}] ${loc(f)}  ${f.ruleId}`,
      `      ${f.message}`,
      `      > ${f.excerpt.length > 110 ? `${f.excerpt.slice(0, 107)}...` : f.excerpt}`,
      `      fix: ${f.fix}`,
    ].join('\n'))
    .join('\n');
}

/** All BLOCKs, then at most `cap` WARNs, then a count of what was withheld. */
function capped(findings, cap = WARN_CAP) {
  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  const shown = [...blocks, ...warns.slice(0, cap)].sort((a, b) => a.line - b.line);
  return { shown, hidden: Math.max(0, warns.length - cap) };
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function readPayload() {
  const raw = (await readStdin()).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// commit message extraction
// ---------------------------------------------------------------------------

/**
 * The commit message a `git commit` invocation will actually use, or null when
 * it is not visible in the command line. A gate that cannot see its input must
 * not block, so -F / --file / --template / bare `git commit` all return null.
 */
export function commitMessage(command) {
  if (!/\bgit\b[^\n]*\bcommit\b/.test(command)) return null;
  // Flags that hide the message are only opaque AFTER the `commit` token. `git -C
  // <dir> commit` puts -C before it, where it means "directory" — treating that as
  // --reuse-message silently skipped every commit made the way peyra's own docs
  // mandate. Match on the tail only.
  const tail = command.slice(command.search(/\bcommit\b/));
  if (/\s(?:-F|--file|--template|-t|-C|--reuse-message|--amend\b(?![^\n]*-m))\b/.test(tail)) return null;

  // Heredoc form: git commit -m "$(cat <<'EOF' ... EOF)"
  const heredoc = command.match(/<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\s*\2\s*$|<<-?\s*(['"]?)(\w+)\4\s*\n([\s\S]*?)\n\s*\5\b/);
  if (heredoc) return (heredoc[3] ?? heredoc[6] ?? '').replace(/\s+$/, '');

  const messages = [];
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.raw === '-m' || t.raw === '--message') {
      if (tokens[i + 1]) messages.push(tokens[++i].value);
    } else if (t.raw.startsWith('--message=')) {
      messages.push(t.value.slice('--message='.length));
    } else if (/^-[a-zA-Z]*m$/.test(t.raw) && tokens[i + 1]) {
      messages.push(tokens[++i].value);
    }
  }
  return messages.length ? messages.join('\n\n') : null;
}

/** Shell-ish tokenizer: enough to find -m arguments, not a shell. */
function tokenize(s) {
  const out = [];
  let raw = '';
  let value = '';
  let quote = null;
  const push = () => {
    if (raw !== '' || value !== '') out.push({ raw, value });
    raw = '';
    value = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; raw += c; continue; }
      if (c === '\\' && quote === '"' && i + 1 < s.length) { value += s[++i]; raw += c; continue; }
      value += c;
      raw += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; raw += c; continue; }
    if (/\s/.test(c)) { push(); continue; }
    value += c;
    raw += c;
  }
  push();
  return out;
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

async function modeWrite() {
  const payload = await readPayload();
  const filePath = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!filePath || !fs.existsSync(filePath)) return 0;
  if (isExcluded(filePath) || !SCANNABLE.test(filePath)) return 0;

  const { findings } = scanFile(filePath);
  const fresh = applyBaseline(findings, findBaseline(path.dirname(filePath)), path.resolve(filePath));
  const root = repoRoot(path.dirname(filePath));
  const rel = root ? path.relative(root, filePath) : filePath;
  if (!fresh.length) return 0;

  const { shown, hidden } = capped(fresh);
  process.stderr.write(`no-slop found ${fresh.length} issue(s) in ${rel}:\n${render(shown, { file: rel })}\n`);
  if (hidden) process.stderr.write(`  +${hidden} more warning(s) — see: no-slop scan ${rel} --all\n`);
  process.stderr.write('These are style tripwires, not a build failure. Fix what is genuinely slop and move on.\n');
  return 2;
}

async function modeCommit() {
  const payload = await readPayload();
  const command = payload.tool_input?.command ?? '';
  const message = commitMessage(command);
  if (message === null || message.trim() === '') return 0; // cannot see it, cannot judge it

  const config = loadConfig(process.cwd());
  const { findings } = scan(message, { ruleClasses: new Set(['commit']), config });
  if (!findings.length) return 0;

  const blocks = findings.filter((f) => f.severity === 'block');
  const stream = blocks.length ? process.stderr : process.stdout;
  stream.write(`no-slop: commit message\n${render(blocks.length ? blocks : findings)}\n`);
  return blocks.length ? 2 : 0;
}

async function modeTurn() {
  const payload = await readPayload();
  const transcript = payload.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return 0;

  let text = '';
  try {
    const lines = fs.readFileSync(transcript, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && !text; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry?.message?.role !== 'assistant') continue;
      const content = entry.message.content;
      text = (Array.isArray(content) ? content : [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }
  } catch {
    return 0;
  }
  if (!text.trim()) return 0;

  const { findings } = scan(text, { ruleClasses: new Set(['prose']), config: loadConfig(process.cwd()) });
  if (!findings.length) return 0;
  const { shown, hidden } = capped(findings);
  process.stdout.write(`no-slop (prose, advisory):\n${render(shown)}\n`);
  if (hidden) process.stdout.write(`  +${hidden} more\n`);
  return 0; // Stop is advisory by construction
}

async function modeScan(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const targets = argv.filter((a) => !a.startsWith('-'));
  const severityArg = argv.find((a) => a.startsWith('--severity='));
  const minSeverity = severityArg ? severityArg.split('=')[1] : 'warn';
  if (!['warn', 'block'].includes(minSeverity)) die(`--severity must be "warn" or "block", got "${minSeverity}"`);
  const all = flags.has('--all');

  let total = 0;
  let reported = 0;

  const emit = (label, findings) => {
    const kept = findings.filter((f) => minSeverity !== 'block' || f.severity === 'block');
    total += kept.length;
    if (!kept.length) return;
    const { shown, hidden } = all ? { shown: kept, hidden: 0 } : capped(kept);
    reported += shown.length;
    process.stdout.write(`${label}\n${render(shown, { file: label })}\n`);
    if (hidden) process.stdout.write(`  +${hidden} more (--all)\n`);
  };

  if (flags.has('--stdin')) {
    const classes = new Set();
    for (const c of RULE_CLASSES) if (flags.has(`--${c}`)) classes.add(c);
    if (flags.has('--code')) { classes.add('comment'); classes.add('naming'); }
    if (!classes.size) { classes.add('comment'); classes.add('naming'); }
    const text = await readStdin();
    // A commit body may contain blank lines, so `git log --format=%B` has no
    // unambiguous message boundary. Split only on an explicit NUL or record
    // separator; otherwise treat the stream as one message and say so, rather
    // than guessing and reporting line numbers against the wrong message.
    let messages = [text];
    if (classes.has('commit')) {
      if (/[\x00\x1e]/.test(text)) {
        messages = text.split(/[\x00\x1e]\n?/).map((m) => m.trim()).filter(Boolean);
      } else if (text.includes('\n')) {
        process.stderr.write('no-slop: no NUL separator found — treating stdin as a single message.\n');
        process.stderr.write('no-slop: for per-commit results use: git log -300 --format=%B%x00\n');
      }
    }
    messages.forEach((m, i) => {
      const { findings } = scan(m, { ruleClasses: classes, config: {} });
      emit(classes.has('commit') ? `<stdin> message ${i + 1}` : '<stdin>', findings);
    });
  } else {
    if (!targets.length) die('scan needs a path, or --stdin');
    for (const target of targets) {
      const stat = fs.statSync(target, { throwIfNoEntry: false });
      if (!stat) die(`no such path: ${target}`);
      const files = stat.isDirectory() ? [...walk(target)] : [target];
      const configCache = new Map();
      // The same baseline the write hook honours, so `scan` and the hook never
      // disagree about what counts as a finding. --no-baseline shows everything.
      const baseline = flags.has('--no-baseline')
        ? null
        : findBaseline(stat.isDirectory() ? target : path.dirname(target));
      for (const file of files) {
        const dir = path.dirname(file);
        if (!configCache.has(dir)) configCache.set(dir, loadConfig(dir));
        const extraClasses = flags.has('--prose') ? new Set(['prose']) : undefined;
        const { findings } = scanFile(file, { config: configCache.get(dir), extraClasses });
        emit(path.relative(process.cwd(), file) || file, applyBaseline(findings, baseline, path.resolve(file)));
      }
    }
  }

  if (!total) process.stdout.write('no-slop: clean\n');
  else process.stdout.write(`no-slop: ${total} finding(s)${reported < total ? ` (${reported} shown)` : ''}\n`);
  return total ? 1 : 0;
}

function modeBaseline(argv) {
  const target = argv.find((a) => !a.startsWith('-')) ?? process.cwd();
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) die(`no such path: ${target}`);
  // Paths in the baseline are relative to wherever it lands. Prefer the git
  // root; fall back to the target so a non-git directory still works.
  const root = repoRoot(target) ?? path.resolve(stat.isDirectory() ? target : path.dirname(target));

  const findings = {};
  let count = 0;
  const configCache = new Map();
  for (const file of stat.isDirectory() ? walk(target) : [target]) {
    const dir = path.dirname(file);
    if (!configCache.has(dir)) configCache.set(dir, loadConfig(dir));
    const { findings: existing } = scanFile(file, { config: configCache.get(dir) });
    if (!existing.length) continue;
    findings[path.relative(root, file)] = existing.map(baselineKey);
    count += existing.length;
  }

  const out = path.join(root, BASELINE_FILE);
  fs.writeFileSync(out, `${JSON.stringify({ version: 1, findings }, null, 2)}\n`);
  process.stdout.write(`no-slop: baselined ${count} existing finding(s) across ${Object.keys(findings).length} file(s)\n`);
  process.stdout.write(`no-slop: wrote ${path.relative(process.cwd(), out) || out} — only NEW findings will be reported from here.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const USAGE = `no-slop — a tripwire for mechanical AI slop.

  no-slop write               PostToolUse hook (stdin JSON). Reports; cannot prevent.
  no-slop commit              PreToolUse hook (stdin JSON). Blocks the commit on BLOCK findings.
  no-slop turn                Stop hook (stdin JSON). Advisory prose check.
  no-slop scan <path>...      Scan files or directories.
  no-slop scan --stdin [--commit|--prose|--code]
  no-slop baseline [path]     Snapshot current findings and suppress them from now on.

Flags: --all (no output cap), --severity=warn|block, --no-baseline
`;

async function main() {
  const [mode, ...argv] = process.argv.slice(2);
  switch (mode) {
    case 'write': return modeWrite();
    case 'commit': return modeCommit();
    case 'turn': return modeTurn();
    case 'scan': return modeScan(argv);
    case 'baseline': return modeBaseline(argv);
    case '--help': case '-h': case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`no-slop: unknown mode "${mode}"\n\n${USAGE}`);
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`no-slop: ${err.stack ?? err}\n`);
    process.exit(1);
  });
}
