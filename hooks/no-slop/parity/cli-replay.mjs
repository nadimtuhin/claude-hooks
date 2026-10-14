#!/usr/bin/env node
// CLI-level replay: runs `node hook.mjs <mode>` and the Go binary over identical payloads in identical temp
// repos and compares exit code, stdout, stderr (and files written). Usage: node cli-replay.mjs [--go BIN] [--verbose]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, '..', 'hook.mjs');
const fixturesDir = path.join(here, 'fixtures');
const args = process.argv.slice(2);
const goArg = args.indexOf('--go');
const goBin = path.resolve(goArg === -1 ? process.env.PARITY_GO_BIN ?? path.join(here, '..', 'go', 'no-slop') : args[goArg + 1]);
const verbose = args.includes('--verbose');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) copyTree(src, path.join(to, e.name));
    else fs.copyFileSync(src, path.join(to, e.name));
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (!e.name.endsWith('.json') || !p.includes('fx')) out.push(path.relative(base, p));
  }
  return out;
}

const writePayload = (file) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } });
const commitPayload = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const turnPayload = (file) => JSON.stringify({ transcript_path: file });

const fixtureFiles = listFiles(fixturesDir).filter((f) => !f.endsWith('.json'));
const commits = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'commits.json'), 'utf8'));

const cases = [];
const add = (name, spec) => cases.push({ name, ...spec });

// ---- shared repo with fixtures -------------------------------------------------------------------
for (const rel of fixtureFiles) {
  add(`write ${rel}`, { steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'fx', rel)) }] });
  add(`scan ${rel}`, { steps: () => [{ args: ['scan', path.join('fx', rel)] }] });
  add(`scan --all ${rel}`, { steps: () => [{ args: ['scan', path.join('fx', rel), '--all'] }] });
}
const scanVariants = [
  ['fx'], ['fx', '--all'], ['fx', '--severity=block'], ['fx', '--no-baseline'], ['fx/with-baseline'], ['fx/with-baseline', '--no-baseline'],
  ['fx', '--prose'], ['fx/edge', 'fx/recorded'], ['nonexistent'], [], ['--severity=bogus', 'fx'], ['fx/recorded/plain-1.ts', '--severity=block'],
  ['fx/with-config'], ['fx/with-config/nested'], ['fx', '--all', '--severity=warn'], ['fx/edge/emoji.ts', 'fx/edge/emoji.ts'],
];
for (const v of scanVariants) add(`scan ${v.join(' ')}`, { steps: () => [{ args: ['scan', ...v] }] });
add('scan absolute dir', { steps: (d) => [{ args: ['scan', path.join(d, 'fx', 'edge'), '--all'] }] });
add('scan from nested cwd', { cwd: 'fx/edge', steps: () => [{ args: ['scan', '.', '--all'] }] });

const stdinSamples = {
  code: '// This is a robust solution\nconst result = await fetchData();\n// per your request\nlet data = 1;\n',
  empty: '',
  crlf: '// robust seamless\r\nconst x = 1;\r\n',
  unicode: '// 😀 robust solution 😀\nconst বাংলা = 1;\n',
};
for (const [name, text] of Object.entries(stdinSamples)) {
  for (const flags of [[], ['--prose'], ['--code'], ['--commit'], ['--testfile'], ['--style'], ['--naming', '--comment']]) {
    add(`scan --stdin ${flags.join(' ')} [${name}]`, { steps: () => [{ args: ['scan', '--stdin', ...flags], stdin: text }] });
  }
}
const stdinCommit = {
  nul: 'fix: a\0Add cutting-edge parser\n\nBody line\0wip\0',
  rs: 'fix: a\x1ewip\x1e\n',
  multi: 'fix: handle x\n\nThis commit introduces a robust, seamless solution.\n',
  single: 'wip\n',
  singleNoNl: 'wip',
  longSubject: `${'a'.repeat(100)}\n`,
  blanks: '\0\0\n\0',
};
for (const [name, text] of Object.entries(stdinCommit)) {
  add(`scan --stdin --commit [${name}]`, { steps: () => [{ args: ['scan', '--stdin', '--commit'], stdin: text }] });
  add(`scan --stdin --commit --severity=block [${name}]`, { steps: () => [{ args: ['scan', '--stdin', '--commit', '--severity=block', '--all'], stdin: text }] });
}

const commands = [
  'git status', 'ls', '', 'git commit', 'git commit -m "wip"', 'git commit -am "Add cutting-edge parser"', 'git commit --message="fix: ok"',
  'git commit --message "fix: ok"', 'git commit -F msg.txt', 'git commit --amend', 'git commit --amend -m "wip"', 'git -C fx commit -m "wip"',
  'git add . && git commit -m "Updated stuff and various changes"', 'git commit -m "fix: a" -m "This commit introduces a robust solution"',
  'git commit -m \'it\'"\'"\'s a \\"quote\\"\'', 'git commit -m "unterminated', 'git commit -m', 'git commit -m ""', 'git commit -m "   "',
  `git commit -m "${'x'.repeat(80)}"`, 'git commit -m "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"',
  'git commit -t tpl', 'git commit -C HEAD', 'echo git commit -m "wip"', 'git log --oneline | git commit -m wip',
  "git commit -m \"$(cat <<'EOF'\nfix: a\n\nThis commit introduces a robust, seamless solution.\nEOF\n)\"",
  "git commit -m \"$(cat <<-EOF\n  wip\n  EOF\n)\"", 'git commit -m "$(cat <<"EOF"\nfix: quoted delim\nEOF\n)"',
  "git commit -m \"$(cat <<'EOF'\n\nEOF\n)\"", 'git commit <<EOF\nAdd cutting-edge parser\nEOF',
];
for (const c of commands) add(`commit ${JSON.stringify(c).slice(0, 70)}`, { steps: () => [{ args: ['commit'], stdin: commitPayload(c) }] });
for (const m of commits) {
  add(`commit heredoc ${JSON.stringify(m).slice(0, 50)}`, { steps: () => [{ args: ['commit'], stdin: commitPayload(`git commit -m "$(cat <<'EOF'\n${m}\nEOF\n)"`) }] });
  add(`commit -m (config cwd) ${JSON.stringify(m).slice(0, 50)}`, { cwd: 'fx/with-config', steps: () => [{ args: ['commit'], stdin: commitPayload(`git commit -m ${JSON.stringify(m)}`) }] });
}

const rawPayloads = {
  empty: '', blank: '   \n', object: '{}', null: 'null', array: '[]', string: '"s"', number: '123', true: 'true', malformed: '{ not json',
  toolInputNull: '{"tool_input":null}', toolInputString: '{"tool_input":"x"}', fileNumber: '{"tool_input":{"file_path":123}}',
  fileEmpty: '{"tool_input":{"file_path":""}}', fileMissing: '{"tool_input":{"file_path":"nope/none.ts"}}', fileDir: '{"tool_input":{"file_path":"fx"}}',
  fileNull: '{"tool_input":{"file_path":null,"notebook_path":"fx/edge/emoji.ts"}}', notebook: '{"tool_input":{"notebook_path":"fx/edge/emoji.ts"}}',
  excluded: '{"tool_input":{"file_path":"node_modules/x/emoji.ts"}}', nonScannable: '{"tool_input":{"file_path":"fx/commits.json"}}',
  relative: '{"tool_input":{"file_path":"fx/edge/emoji.ts"}}', bom: '﻿{"tool_input":{"file_path":"fx/edge/emoji.ts"}}',
  commandNumber: '{"tool_input":{"command":123}}', commandNull: '{"tool_input":{"command":null}}', commandArray: '{"tool_input":{"command":["git","commit"]}}',
  transcriptNumber: '{"transcript_path":123}', transcriptMissing: '{"transcript_path":"nope.jsonl"}', transcriptEmpty: '{"transcript_path":""}',
  transcriptDir: '{"transcript_path":"fx"}',
  deepUnterminated: `{"tool_input":{"command":"git commit -m wip","x":${'['.repeat(2_000_000)}`,
  deepBare: '['.repeat(8_000_000),
  deepValid9999: `{"tool_input":{"command":"git commit -m \\"Updated stuff and various changes\\"","x":${'['.repeat(9_990)}${']'.repeat(9_990)}}}`,
};
for (const [name, text] of Object.entries(rawPayloads)) {
  for (const mode of ['write', 'commit', 'turn']) add(`${mode} payload ${name}`, { steps: () => [{ args: [mode], stdin: text }] });
}
for (const a of [[], ['--help'], ['-h'], ['bogus'], ['write', 'extra'], ['baseline', 'nonexistent'], ['--version']]) {
  add(`argv ${a.join(' ') || '(none)'}`, { steps: () => [{ args: a }] });
}

// ---- turn transcripts ----------------------------------------------------------------------------
const assistant = (...blocks) => JSON.stringify({ message: { role: 'assistant', content: blocks } });
const textBlock = (text) => ({ type: 'text', text });
const slopText = 'Great question! Here is a robust, seamless, cutting-edge solution.\nI hope this helps. Let me know if you have any questions!\n';
const transcripts = {
  basic: [assistant(textBlock(slopText))].join('\n'),
  clean: [assistant(textBlock('Done. Tests pass.'))].join('\n'),
  blank: [assistant(textBlock('   '))].join('\n'),
  crlf: [assistant(textBlock(slopText))].join('\r\n'),
  trailingBlank: `${assistant(textBlock(slopText))}\n\n\n`,
  malformedLast: `${assistant(textBlock(slopText))}\n{ broken`,
  malformedFirst: `{ broken\n${assistant(textBlock(slopText))}`,
  malformedBeforeText: `${assistant(textBlock('wip'))}\n{ broken\n${assistant({ type: 'tool_use', name: 'x' })}`,
  toolUseOnlyThenText: `${assistant(textBlock(slopText))}\n${assistant({ type: 'tool_use', name: 'x' })}`,
  toolUseOnly: assistant({ type: 'tool_use', name: 'x' }),
  nullLine: `${assistant(textBlock(slopText))}\nnull`,
  numberLine: `${assistant(textBlock(slopText))}\n5`,
  userLast: `${assistant(textBlock(slopText))}\n${JSON.stringify({ message: { role: 'user', content: [textBlock('hi')] } })}`,
  contentString: JSON.stringify({ message: { role: 'assistant', content: slopText } }),
  contentNull: JSON.stringify({ message: { role: 'assistant', content: null } }),
  blockNull: JSON.stringify({ message: { role: 'assistant', content: [null] } }),
  blockTextNumber: JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 5 }] } }),
  blockTextMissing: JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text' }, textBlock(slopText)] } }),
  multiBlock: assistant(textBlock('Great question!'), { type: 'tool_use' }, textBlock('robust seamless solution')),
  manyWarns: assistant(textBlock(Array.from({ length: 12 }, (_, i) => `Line ${i}: this is a robust, seamless, cutting-edge, game-changing solution. Great question!`).join('\n'))),
  emoji: assistant(textBlock('😀 robust seamless 😀 '.repeat(40))),
  empty: '',
  newlinesOnly: '\n\n',
  bom: `﻿${assistant(textBlock(slopText))}`,
};
for (const [name, body] of Object.entries(transcripts)) {
  add(`turn transcript ${name}`, {
    isolated: true,
    setup: (d) => fs.writeFileSync(path.join(d, 't.jsonl'), body),
    steps: (d) => [{ args: ['turn'], stdin: turnPayload(path.join(d, 't.jsonl')) }],
  });
}
add('turn invalid utf8 transcript', {
  isolated: true,
  setup: (d) => fs.writeFileSync(path.join(d, 't.jsonl'), Buffer.concat([Buffer.from(`{"message":{"role":"assistant","content":[{"type":"text","text":"robust seamless ÿ"`), Buffer.from([0xff, 0xfe]), Buffer.from('}]}}')])),
  steps: (d) => [{ args: ['turn'], stdin: turnPayload(path.join(d, 't.jsonl')) }],
});

// ---- config ---------------------------------------------------------------------------------------
const slopFile = '// This is a robust solution, per your request\nconst data = 1;\n';
const configs = {
  notJson: '{ not json', empty: '', openObject: '{"rules":', openArray: '[1,', nul: 'nul', singleQuote: "{'a':1}", trailingComma: '{"a":1,}', bom: '﻿{"rules":{}}',
  trailingGarbage: '{"rules":{}} x', unknownRule: '{"rules":{"nope-rule":"off"}}', rulesArray: '{"rules":[]}', rulesNull: '{"rules":null}', noRules: '{}',
  off: '{"rules":{"comment-provenance":"off"}}', objSeverity: '{"rules":{"comment-provenance":{"severity":"block"}}}', badLevel: '{"rules":{"comment-provenance":"bogus"}}',
  numberValue: '{"rules":{"comment-provenance":5}}', nullValue: '{"rules":{"comment-provenance":null}}', unknownOption: '{"rules":{"comment-provenance":{"severity":"off","x":1}}}',
  arrayValue: '{"rules":{"comment-provenance":[]}}', topNull: 'null', topString: '"s"', topNumber: '123', topTrue: 'true', topArray: '[]',
  missingColon: '{"a" 1}', missingValue: '{"a":}', missingComma: '[1 2]', badLiteral: '{"a":tru}', rawNewline: '{"a":"\n"}', badEscape: '{"a":"\\x"}',
  unterminated: '{"a":"abc', controlChar: '\u0000', lone: '{', closeBrace: '}', badNumber: '{"a":01}', exponent: '{"a":1e}', minus: '-', unicodeBad: '{"a":"\\u12"}',
  longGarbage: `{"rules":{}${'x'.repeat(60)}`, emoji: '{"😀":}', tabs: '{\t"rules":\t{}}', threshold: '{"rules":{"comment-density":{"minComments":1,"minCode":1}}}',
  badThreshold: '{"rules":{"comment-density":{"minComments":0}}}', floatThreshold: '{"rules":{"comment-density":{"minComments":1.5}}}', subjectMax: '{"rules":{"commit-subject-too-long":{"max":5}}}',
  noOptions: '{"rules":{"naming-inflated":{"max":5}}}', duplicate: '{"rules":{"comment-provenance":"off","comment-provenance":"block"}}',
};
for (const [name, body] of Object.entries(configs)) {
  add(`config ${name}`, {
    isolated: true,
    setup: (d) => {
      fs.writeFileSync(path.join(d, '.no-slop.json'), body);
      fs.writeFileSync(path.join(d, 'a.ts'), slopFile);
    },
    steps: (d) => [
      { args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) },
      { args: ['scan', 'a.ts', '--all'] },
      { args: ['commit'], stdin: commitPayload('git commit -m "wip"') },
      { args: ['turn'], stdin: turnPayload(path.join(d, 'a.ts')) },
      { args: ['baseline', 'a.ts'] },
    ],
  });
}
add('config is a directory', {
  isolated: true,
  setup: (d) => {
    fs.mkdirSync(path.join(d, '.no-slop.json'));
    fs.writeFileSync(path.join(d, 'a.ts'), slopFile);
  },
  steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) }, { args: ['scan', 'a.ts'] }],
});
add('config parent merge + leaf override', {
  isolated: true,
  setup: (d) => {
    fs.mkdirSync(path.join(d, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(d, '.no-slop.json'), '{"rules":{"comment-provenance":{"severity":"block"},"naming-inflated":"off"}}');
    fs.writeFileSync(path.join(d, 'sub', '.no-slop.json'), '{"rules":{"comment-provenance":{"severity":"warn"}}}');
    fs.writeFileSync(path.join(d, 'sub', 'deep', '.no-slop.json'), '{"rules":{"naming-inflated":"block"}}');
    fs.writeFileSync(path.join(d, 'sub', 'deep', 'a.ts'), `${slopFile}const robustManager = 1;\n`);
  },
  steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'sub', 'deep', 'a.ts')) }, { args: ['scan', 'sub', '--all'] }],
});
add('config above git root is ignored', {
  isolated: true,
  setup: (d) => {
    fs.mkdirSync(path.join(d, 'repo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.no-slop.json'), '{ broken');
    fs.writeFileSync(path.join(d, 'repo', 'a.ts'), slopFile);
  },
  noGit: true,
  steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'repo', 'a.ts')) }],
});

// ---- baseline -------------------------------------------------------------------------------------
const baselines = {
  notJson: '{ bad', empty: '', null: 'null', array: '[]', findingsNull: '{"findings":null}', findingsString: '{"findings":"x"}', valueString: '{"findings":{"a.ts":"1:comment-provenance"}}',
  valueNumber: '{"findings":{"a.ts":5}}', valueMixed: '{"findings":{"a.ts":[1,"1:comment-provenance"]}}', valueNull: '{"findings":{"a.ts":null}}', valueObject: '{"findings":{"a.ts":{}}}',
  good: '{"version":1,"findings":{"a.ts":["1:comment-provenance"]}}', otherFile: '{"version":1,"findings":{"b.ts":["1:comment-provenance"]}}', noFindings: '{"version":1}',
  proto: '{"findings":{"__proto__":["1:x"]}}', constructor: '{"findings":{"constructor":["1:x"]}}',
};
for (const [name, body] of Object.entries(baselines)) {
  add(`baseline file ${name}`, {
    isolated: true,
    setup: (d) => {
      fs.writeFileSync(path.join(d, '.no-slop-baseline.json'), body);
      fs.writeFileSync(path.join(d, 'a.ts'), slopFile);
    },
    steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) }, { args: ['scan', 'a.ts', '--all'] }, { args: ['scan', 'a.ts', '--no-baseline'] }],
  });
}
const baselineRuns = [
  [['baseline', 'fx']], [['baseline']], [['baseline', 'fx/recorded/plain-1.ts']], [['baseline', 'fx/edge']], [['baseline', 'fx'], ['scan', 'fx']],
  [['baseline', 'fx'], ['write']], [['baseline', 'fx/with-config']], [['baseline', '--x', 'fx/edge']],
];
for (const runs of baselineRuns) {
  for (const git of [true, false]) {
    add(`baseline ${runs.map((r) => r.join(' ')).join(' ; ')} git=${git}`, {
      isolated: true,
      noGit: !git,
      setup: (d) => copyTree(fixturesDir, path.join(d, 'fx')),
      steps: (d) => runs.map((r) => ({ args: r, stdin: r[0] === 'write' ? writePayload(path.join(d, 'fx', 'edge', 'emoji.ts')) : undefined })),
      after: (d) => [d].flatMap((x) => (fs.existsSync(path.join(x, '.no-slop-baseline.json')) ? [fs.readFileSync(path.join(x, '.no-slop-baseline.json'), 'utf8')] : ['(no baseline file)'])),
    });
  }
}
add('baseline into read-only dir', {
  isolated: true,
  setup: (d) => {
    fs.mkdirSync(path.join(d, 'ro'));
    fs.writeFileSync(path.join(d, 'ro', 'a.ts'), slopFile);
    fs.chmodSync(path.join(d, 'ro'), 0o555);
  },
  noGit: true,
  steps: () => [{ args: ['baseline', 'ro'] }],
  cleanup: (d) => fs.chmodSync(path.join(d, 'ro'), 0o755),
});

const unreadable = {
  'source file': { file: 'a.ts', steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) }, { args: ['scan', 'a.ts'] }, { args: ['baseline', 'a.ts'] }] },
  'config file': { file: '.no-slop.json', steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) }, { args: ['scan', 'a.ts'] }] },
  'baseline file': { file: '.no-slop-baseline.json', steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'a.ts')) }, { args: ['scan', 'a.ts'] }] },
  transcript: { file: 't.jsonl', steps: (d) => [{ args: ['turn'], stdin: turnPayload(path.join(d, 't.jsonl')) }] },
};
for (const [name, spec] of Object.entries(unreadable)) {
  add(`unreadable ${name}`, {
    isolated: true,
    setup: (d) => {
      fs.writeFileSync(path.join(d, 'a.ts'), slopFile);
      fs.writeFileSync(path.join(d, '.no-slop.json'), '{"rules":{}}');
      fs.writeFileSync(path.join(d, '.no-slop-baseline.json'), '{"findings":{}}');
      fs.writeFileSync(path.join(d, 't.jsonl'), assistant(textBlock(slopText)));
      fs.chmodSync(path.join(d, spec.file), 0o000);
    },
    steps: spec.steps,
    cleanup: (d) => fs.chmodSync(path.join(d, spec.file), 0o644),
  });
}
add('unreadable directory', {
  isolated: true,
  setup: (d) => {
    fs.mkdirSync(path.join(d, 'locked'));
    fs.writeFileSync(path.join(d, 'locked', 'a.ts'), slopFile);
    fs.chmodSync(path.join(d, 'locked'), 0o000);
  },
  steps: (d) => [{ args: ['write'], stdin: writePayload(path.join(d, 'locked', 'a.ts')) }, { args: ['scan', 'locked'] }, { args: ['scan', 'locked/a.ts'] }, { args: ['baseline', 'locked'] }],
  cleanup: (d) => fs.chmodSync(path.join(d, 'locked'), 0o755),
});

// ---- running --------------------------------------------------------------------------------------
function normalise(text, dirs) {
  let out = text;
  for (const d of dirs) out = out.split(d).join('<D>');
  return out;
}

function normaliseStderr(text) {
  const lines = text.split('\n');
  const stackStart = lines.findIndex((l, i) => i > 0 && /^\s+at /.test(l));
  return stackStart === -1 ? text : `${lines.slice(0, stackStart).join('\n')}\n`;
}

function runImpl(impl, root) {
  const results = [];
  const realRoot = fs.realpathSync(root);
  const shared = path.join(root, 'shared');
  fs.mkdirSync(path.join(shared, '.git'), { recursive: true });
  copyTree(fixturesDir, path.join(shared, 'fx'));
  cases.forEach((c, i) => {
    let dir = shared;
    if (c.isolated) {
      dir = path.join(root, `c${i}`);
      fs.mkdirSync(dir, { recursive: true });
      if (!c.noGit) fs.mkdirSync(path.join(dir, '.git'));
      c.setup(dir);
    }
    const dirs = [fs.realpathSync(dir), dir, realRoot, root];
    const outputs = [];
    for (const step of c.steps(dir)) {
      const cwd = c.cwd ? path.join(dir, c.cwd) : dir;
      const [cmd, argv] = impl === 'node' ? [process.execPath, [hookPath, ...step.args]] : [goBin, step.args];
      const run = spawnSync(cmd, argv, { cwd, input: step.stdin ?? '', encoding: 'utf8', timeout: 30000 });
      outputs.push({
        args: normalise(step.args.join(' '), dirs),
        status: run.status,
        stdout: normalise(run.stdout ?? '', dirs),
        stderr: normalise(normaliseStderr(run.stderr ?? ''), dirs),
      });
    }
    if (c.after) outputs.push({ after: c.after(dir).map((t) => normalise(t, dirs)) });
    c.cleanup?.(dir);
    results.push(outputs);
  });
  return results;
}

if (!fs.existsSync(goBin)) {
  console.error(`parity: go binary not found at ${goBin}`);
  process.exit(1);
}

const nodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-parity-n-'));
const goRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-parity-g-'));
let nodeResults;
let goResults;
try {
  nodeResults = runImpl('node', nodeRoot);
  goResults = runImpl('go', goRoot);
} finally {
  fs.rmSync(nodeRoot, { recursive: true, force: true });
  fs.rmSync(goRoot, { recursive: true, force: true });
}

let diffCount = 0;
const shown = [];
cases.forEach((c, i) => {
  const a = JSON.stringify(nodeResults[i]);
  const b = JSON.stringify(goResults[i]);
  if (a === b) return;
  diffCount++;
  shown.push(`DIFF ${c.name}\n  node: ${a.slice(0, 700)}\n  go:   ${b.slice(0, 700)}`);
});
console.log(`cli-replay: ${cases.length} cases, ${diffCount} diffs`);
for (const s of shown.slice(0, verbose ? shown.length : 8)) console.log(s);
process.exit(diffCount ? 1 : 0);
