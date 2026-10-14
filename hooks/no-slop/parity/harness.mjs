#!/usr/bin/env node
// Differential harness: runs the Node reference and the Go port over the same corpora and diffs the findings.
// Usage: node harness.mjs [--fixtures-only | --budget] [--root PATH]... [--go BIN] [--transcripts DIR] [--max-prose N] [--max-commits N] [--verbose]
// --budget runs both sides with the production 200ms scan budget over slow-but-legit files and requires 0 diffs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitMessage, loadConfig, scanFileFindings, walk } from '../hook.mjs';
import { RULES, scan } from '../slop-rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const optionAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const goBin = path.resolve(option('--go') ?? process.env.PARITY_GO_BIN ?? path.join(here, '..', 'go', 'no-slop'));
const budgetMode = flag('--budget');
const fixturesOnly = flag('--fixtures-only');
const nodeBudget = budgetMode ? {} : { budgetMs: Infinity };
const roots = fixturesOnly || budgetMode ? [] : [...optionAll('--root'), ...(process.env.PARITY_ROOTS ?? '').split(path.delimiter).filter(Boolean)];
const transcriptsDir = option('--transcripts') ?? path.join(os.homedir(), '.claude', 'projects');
const maxProse = Number(option('--max-prose') ?? 300);
const maxCommits = Number(option('--max-commits') ?? 2000);
const verbose = flag('--verbose');
const CHUNK = 1500;

const realExit = process.exit;
const wellFormed = (s) => (typeof s === 'string' ? s.toWellFormed() : s);

function normalise(findings) {
  return findings.map((f) => ({
    ruleId: f.ruleId,
    severity: f.severity,
    line: f.line,
    excerpt: wellFormed(f.excerpt),
    message: wellFormed(f.message),
    fix: wellFormed(f.fix),
  }));
}

const firstLine = (text) => String(text).split('\n')[0];

function nodeSide(fn) {
  process.exit = (code) => {
    throw new Error(`process.exit(${code})`);
  };
  try {
    return fn();
  } catch (e) {
    return { error: firstLine(e?.message ?? e) };
  } finally {
    process.exit = realExit;
  }
}

function goRun(kind, inputs, timeout) {
  const dumpArgs = budgetMode ? ['__dump', kind, '--budget'] : ['__dump', kind];
  const run = spawnSync(goBin, dumpArgs, { input: JSON.stringify(inputs), maxBuffer: 1 << 30, encoding: 'utf8', timeout });
  if (run.error?.code === 'ETIMEDOUT') return { error: `killed after ${timeout}ms` };
  if (run.status !== 0) return { error: firstLine(run.stderr).replace(/^no-slop: (?:Error: )?/, '') };
  return { items: JSON.parse(run.stdout) };
}

function goSide(kind, inputs) {
  const out = [];
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const chunk = inputs.slice(i, i + CHUNK);
    const batch = goRun(kind, chunk);
    if (batch.items) {
      out.push(...batch.items);
      continue;
    }
    for (const one of chunk) {
      const single = goRun(kind, [one]);
      out.push(single.items?.[0] ?? { error: single.error });
    }
  }
  return out;
}

const nodeScanOptions = (classes) => ({ ruleClasses: new Set(classes), config: loadConfig(process.cwd()), ...nodeBudget });

const nodeHandlers = {
  files: (p) => ({ findings: normalise(scanFileFindings(p, nodeBudget)) }),
  proseFile: (p) => ({ findings: normalise(scanFileFindings(p, { extraClasses: new Set(['prose']), ...nodeBudget })) }),
  message: (m) => ({ findings: normalise(scan(m, nodeScanOptions(['commit'])).findings) }),
  prose: (t) => ({ findings: normalise(scan(t, nodeScanOptions(['prose'])).findings) }),
  command: (cmd) => {
    const message = commitMessage(cmd);
    if (message === null || message.trim() === '') return { message: null, findings: [] };
    return { message: wellFormed(message), findings: normalise(scan(message, nodeScanOptions(['commit'])).findings) };
  },
};

function normaliseGo(item) {
  if (item.error) return item;
  const out = { ...item };
  out.findings = (item.findings ?? []).map((f) => ({ ...f }));
  if (!('message' in item)) delete out.message;
  return out;
}

const report = [];
const diffs = [];
const rulesSeen = new Map();

function compare(corpus, kind, inputs, label = (x) => String(x).slice(0, 80)) {
  const node = inputs.map((x) => nodeSide(() => nodeHandlers[kind](x)));
  const go = goSide(kind, inputs).map(normaliseGo);
  let findings = 0;
  let diffCount = 0;
  inputs.forEach((x, i) => {
    findings += node[i].findings?.length ?? 0;
    if (corpus.startsWith('fixtures')) for (const f of node[i].findings ?? []) rulesSeen.set(f.ruleId, (rulesSeen.get(f.ruleId) ?? 0) + 1);
    const a = JSON.stringify(node[i]);
    const b = JSON.stringify(go[i]);
    if (a === b) return;
    diffCount++;
    diffs.push({ corpus, input: label(x), node: a.slice(0, 600), go: b.slice(0, 600) });
  });
  report.push({ corpus, items: inputs.length, findings, diffs: diffCount });
}

function compareWalk(corpus, root) {
  const nodeList = [...walk(root)];
  const goList = goSide('walk', [root])[0]?.files ?? [];
  const same = JSON.stringify(nodeList) === JSON.stringify(goList);
  report.push({ corpus, items: nodeList.length, findings: 0, diffs: same ? 0 : 1 });
  if (!same) {
    const extra = nodeList.filter((p) => !goList.includes(p)).slice(0, 3);
    const missing = goList.filter((p) => !nodeList.includes(p)).slice(0, 3);
    diffs.push({ corpus, input: root, node: JSON.stringify({ onlyNode: extra, total: nodeList.length }), go: JSON.stringify({ onlyGo: missing, total: goList.length }) });
  }
  return nodeList;
}

function listAll(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p));
    else if (!e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function gitMessages(root) {
  const run = spawnSync('git', ['-C', root, 'log', '--format=%B%x00', '-n', String(maxCommits)], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0) return [];
  return run.stdout.split('\0').map((m) => m.replace(/^\n/, '')).filter((m) => m.length);
}

const heredocCommand = (m) => `git commit -m "$(cat <<'EOF'\n${m}\nEOF\n)"`;
const inlineCommand = (m) => `git commit -m ${JSON.stringify(m.split('\n')[0])}`;

function commandsFor(messages) {
  return messages.flatMap((m) => [heredocCommand(m), inlineCommand(m)]);
}

function assistantTexts(limit) {
  if (!fs.existsSync(transcriptsDir)) return [];
  const files = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.jsonl')) files.push({ p, mtime: fs.statSync(p).mtimeMs });
    }
  };
  visit(transcriptsDir);
  files.sort((a, b) => b.mtime - a.mtime);
  const texts = [];
  for (const { p } of files) {
    if (texts.length >= limit) break;
    if (fs.statSync(p).size > 50 * 1024 * 1024) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').reverse();
    let taken = 0;
    for (const line of lines) {
      if (texts.length >= limit || taken >= 20) break;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
      const text = entry.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim()) {
        texts.push(text);
        taken++;
      }
    }
  }
  return texts;
}

function runFixtures() {
  const files = listAll(fixturesDir);
  compare('fixtures:files', 'files', files, (p) => path.relative(fixturesDir, p));
  compare('fixtures:proseFile', 'proseFile', files.filter((p) => /\.mdx?$/i.test(p)), (p) => path.relative(fixturesDir, p));
  const commits = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'commits.json'), 'utf8'));
  compare('fixtures:commit-message', 'message', commits);
  compare('fixtures:commit-command', 'command', commandsFor(commits));
  const prose = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'prose.json'), 'utf8'));
  compare('fixtures:prose', 'prose', prose);
}

function runGeneratedOversize() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-slop-parity-'));
  try {
    const manyLines = path.join(dir, 'many-lines.ts');
    fs.writeFileSync(manyLines, 'const a = 1;\n'.repeat(10001));
    const manyBytes = path.join(dir, 'many-bytes.sql');
    fs.writeFileSync(manyBytes, `${'x'.repeat(1000)}\n`.repeat(1100));
    const suppressed = path.join(dir, 'suppressed.sql');
    fs.writeFileSync(suppressed, `-- no-slop-disable file-too-large\n${'select 1;\n'.repeat(10001)}`);
    const missing = path.join(dir, 'missing.ts');
    const files = [manyLines, manyBytes, suppressed, missing];
    compare('fixtures:generated', 'files', files, (p) => path.basename(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WALL_CLOCK_LIMIT_MS = 1000;

// Each file has a finding before and after the slow line, so a side that gives up early reports a different set.
const pathologicalFiles = {
  'glob-body.spec.ts': () => `// as you requested\nit('globs', () => {\n${"  expect(match('src/*.ts', 'a/b.ts')).toBe(true);\n".repeat(1500)}});\n// per your review feedback\n`,
  'comment-openers.ts': () => `// as you requested\na${'//x'.repeat(20000)}\r\n// per your review feedback\n`,
  'backslash-title.spec.ts': () => `// as you requested\nit('${'\\'.repeat(44)}\n\n// per your review feedback\n`,
};

function comparePathological(dir) {
  for (const [name, make] of Object.entries(pathologicalFiles)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, make());
    const t0 = performance.now();
    const node = nodeSide(() => nodeHandlers.files(file));
    const nodeMs = performance.now() - t0;
    const t1 = performance.now();
    const goRaw = goRun('files', [file], WALL_CLOCK_LIMIT_MS * 5);
    const go = goRaw.items ? normaliseGo(goRaw.items[0]) : { error: goRaw.error };
    const goMs = performance.now() - t1;
    const a = JSON.stringify(node);
    const b = JSON.stringify(go);
    const found = node.findings?.length ?? 0;
    const problems = [];
    if (a !== b) problems.push('findings differ');
    if (!found) problems.push('no findings, the file cannot show where a side stopped');
    if (nodeMs > WALL_CLOCK_LIMIT_MS || goMs > WALL_CLOCK_LIMIT_MS) problems.push(`over ${WALL_CLOCK_LIMIT_MS}ms`);
    report.push({ corpus: `budget:${name} (node ${nodeMs.toFixed(0)}ms, go ${goMs.toFixed(0)}ms)`, items: 1, findings: found, diffs: problems.length ? 1 : 0 });
    if (problems.length) diffs.push({ corpus: 'budget:' + name, input: problems.join('; '), node: a.slice(0, 600), go: b.slice(0, 600) });
  }
}

function runBudget() {
  const hookDir = path.join(here, '..');
  const slow = ['slop-rules.mjs', 'hook.mjs', 'slop-rules.test.mjs'].map((n) => path.join(hookDir, n));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-slop-parity-'));
  try {
    const quadratic = path.join(dir, 'quadratic.ts');
    fs.writeFileSync(quadratic, `${'a:'.repeat(999)}a\n`.repeat(499));
    const files = [...listAll(fixturesDir), ...slow, quadratic];
    compare('budget:files', 'files', files, (p) => path.relative(hookDir, p));
    comparePathological(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runRoot(root) {
  const name = path.basename(root);
  const files = compareWalk(`walk:${name}`, root);
  compare(`files:${name}`, 'files', files, (p) => path.relative(root, p));
  compare(`proseFile:${name}`, 'proseFile', files.filter((p) => /\.mdx?$/i.test(p)), (p) => path.relative(root, p));
  const messages = gitMessages(root);
  if (messages.length) {
    compare(`commit-message:${name}`, 'message', messages);
    compare(`commit-command:${name}`, 'command', commandsFor(messages));
  }
}

if (!fs.existsSync(goBin)) {
  console.error(`parity: go binary not found at ${goBin}; build it with: cd hooks/no-slop/go && go build -o no-slop .`);
  realExit(1);
}

if (budgetMode) {
  runBudget();
} else {
  runFixtures();
  runGeneratedOversize();
  for (const root of roots) runRoot(root);
  if (!fixturesOnly) compare('prose:transcripts', 'prose', assistantTexts(maxProse));
}

const corpusWidth = budgetMode ? 62 : 34;
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('corpus', corpusWidth)}${pad('items', 9)}${pad('findings', 10)}diffs`);
for (const r of report) console.log(`${pad(r.corpus, corpusWidth)}${pad(r.items, 9)}${pad(r.findings, 10)}${r.diffs}`);
const knownRuleIds = [...RULES.map((r) => r.id), 'file-too-large', 'pragma-bare'];
const uncovered = budgetMode ? [] : knownRuleIds.filter((id) => !rulesSeen.has(id));
if (!budgetMode) {
  console.log(`\n${pad('rule id (fixture corpora, node side)', 40)}findings`);
  for (const id of knownRuleIds) console.log(`${pad(id, 40)}${rulesSeen.get(id) ?? 0}`);
  if (uncovered.length) console.log(`UNCOVERED rule ids: ${uncovered.join(', ')}`);
}
const total = diffs.length + uncovered.length;
console.log(`total diffs: ${diffs.length}`);
for (const d of diffs.slice(0, verbose ? diffs.length : 5)) {
  console.log(`\nDIFF ${d.corpus} ${d.input}\n  node: ${d.node}\n  go:   ${d.go}`);
}
realExit(total ? 1 : 0);
