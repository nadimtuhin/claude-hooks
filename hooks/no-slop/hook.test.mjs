// Hook-level tests: the JSON payload paths, exit codes, config discovery and
// baseline round-trip. Unit tests on the pure scanner cannot catch a bad
// tool_input path or a config file that silently disables every rule.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitMessage, isExcluded } from './hook.mjs';

const HOOK = fileURLToPath(new URL('./hook.mjs', import.meta.url));

/** Run the hook as a subprocess. Returns { code, stdout, stderr }. */
function run(args, { stdin = '', cwd } = {}) {
  const r = spawnSync(process.execPath, [HOOK, ...args], { input: stdin, encoding: 'utf8', cwd });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-slop-'));
  fs.mkdirSync(path.join(dir, '.git'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel, content) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

// ---------------------------------------------------------------------------

describe('commitMessage extraction', () => {
  test('-m with double quotes', () => {
    assert.equal(commitMessage('git commit -m "fix the parser"'), 'fix the parser');
  });
  test('-m with single quotes', () => {
    assert.equal(commitMessage("git commit -m 'fix the parser'"), 'fix the parser');
  });
  test('--message=', () => {
    assert.equal(commitMessage('git commit --message="fix parser"'), 'fix parser');
  });
  test('combined short flags (-am)', () => {
    assert.equal(commitMessage('git commit -am "fix parser"'), 'fix parser');
  });
  test('two -m flags become subject and body', () => {
    assert.equal(commitMessage('git commit -m "sub" -m "body"'), 'sub\n\nbody');
  });
  test('a chained command still resolves', () => {
    assert.equal(commitMessage('cd /x && git add -A && git commit -m "fix parser"'), 'fix parser');
  });
  test('heredoc form', () => {
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix parser\n\nbody line\nEOF\n)"';
    assert.equal(commitMessage(cmd), 'fix parser\n\nbody line');
  });

  // A gate that cannot see its input must not block.
  for (const cmd of ['git commit -F msg.txt', 'git commit --file=msg.txt', 'git commit --template t', 'git commit', 'git commit -a']) {
    test(`invisible message returns null: ${cmd}`, () => assert.equal(commitMessage(cmd), null));
  }
  test('a non-commit command returns null', () => {
    assert.equal(commitMessage('git log --oneline'), null);
    assert.equal(commitMessage('ls -la'), null);
  });
  test('a word containing "commit" is not a commit', () => {
    assert.equal(commitMessage('echo "no commitment here"'), null);
  });
});

describe('path exclusion', () => {
  for (const p of ['a/node_modules/b.js', 'dist/main.js', 'build/x.ts', 'app.min.js', 'pnpm-lock.yaml', 'x/coverage/y.ts', '/private/tmp/claude-501/-Users-x/abc/scratchpad/detail.py']) {
    test(`excluded: ${p}`, () => assert.ok(isExcluded(p)));
  }
  for (const p of ['src/a.ts', 'main/parser.js', 'lib/distance.ts', 'src/scratchpad.ts']) {
    test(`scanned: ${p}`, () => assert.ok(!isExcluded(p)));
  }
});

// ---------------------------------------------------------------------------

describe('commit mode exit codes', () => {
  const payload = (command) => JSON.stringify({ tool_input: { command } });

  test('slop blocks with exit 2', () => {
    const r = run(['commit'], { stdin: payload('git commit -m "Add cutting-edge parser"') });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /marketing-superlative/);
  });
  test('a clean subject exits 0 silently', () => {
    const r = run(['commit'], { stdin: payload('git commit -m "fix null deref in parser"') });
    assert.equal(r.code, 0);
    assert.equal(r.stdout + r.stderr, '');
  });
  test('-F exits 0 silently', () => {
    const r = run(['commit'], { stdin: payload('git commit -F msg.txt') });
    assert.equal(r.code, 0);
    assert.equal(r.stdout + r.stderr, '');
  });
  test('a warn-only message exits 0 but reports', () => {
    const r = run(['commit'], { stdin: payload('git commit -m "wip"') });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /commit-filler/);
  });
  test('garbage stdin exits 0 rather than crashing', () => {
    assert.equal(run(['commit'], { stdin: 'not json' }).code, 0);
    assert.equal(run(['commit'], { stdin: '' }).code, 0);
  });
});

describe('write mode', () => {
  test('exit 2 and names the file', () => {
    write('a.test.ts', "it('works', () => {});\n");
    const r = run(['write'], { stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.test.ts') } }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /testfile-empty-body/);
  });
  test('a clean file exits 0 silently', () => {
    write('clean.ts', 'export const two = 1 + 1;\n');
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'clean.ts') } }) });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });
  test('a missing file exits 0', () => {
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'nope.ts') } }) });
    assert.equal(r.code, 0);
  });
  test('an excluded path is not scanned', () => {
    write('dist/a.test.ts', "it('works', () => {});\n");
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'dist/a.test.ts') } }) });
    assert.equal(r.code, 0);
  });
  test('warn output is capped at 3 with a +N more line', () => {
    write('many.ts', Array.from({ length: 9 }, (_, i) => `// set the value ${i}\nsetTheValue${i}();`).join('\n'));
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'many.ts') } }) });
    assert.equal((r.stderr.match(/\[WARN\]/g) ?? []).length, 3);
    assert.match(r.stderr, /\+\d+ more warning/);
  });
});

describe('turn mode is advisory', () => {
  test('exits 0 even on a BLOCK finding', () => {
    const transcript = write('t.jsonl', `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: "You're absolutely right, the lock leaks." }] } })}\n`);
    const r = run(['turn'], { stdin: JSON.stringify({ transcript_path: transcript }) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /prose-opener/);
  });
  test('a missing transcript exits 0 silently', () => {
    assert.equal(run(['turn'], { stdin: JSON.stringify({ transcript_path: '/nope' }) }).code, 0);
  });
});

// ---------------------------------------------------------------------------

describe('.no-slop.json', () => {
  const cfg = () => path.join(dir, '.no-slop.json');
  const target = () => path.join(dir, 'cfg.ts');

  test('a rule set to "off" is not reported', () => {
    write('cfg.ts', '// as you requested\n');
    assert.equal(run(['scan', target()]).code, 1);
    fs.writeFileSync(cfg(), JSON.stringify({ rules: { 'comment-provenance': 'off' } }));
    const r = run(['scan', target()]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /clean/);
    fs.rmSync(cfg());
  });

  test('a nested config overrides the root one (leaf wins)', () => {
    fs.writeFileSync(cfg(), JSON.stringify({ rules: { 'comment-provenance': 'off' } }));
    write('pkg/x.ts', '// as you requested\n');
    fs.writeFileSync(path.join(dir, 'pkg/.no-slop.json'), JSON.stringify({ rules: { 'comment-provenance': 'block' } }));
    assert.equal(run(['scan', path.join(dir, 'pkg/x.ts')]).code, 1);
    fs.rmSync(cfg());
    fs.rmSync(path.join(dir, 'pkg/.no-slop.json'));
  });

  // The biggest silent-degradation risk: a config that turns "the linter runs"
  // into "the linter runs and catches nothing". Every read must fail loud.
  test('malformed JSON is a hard error naming the file', () => {
    fs.writeFileSync(cfg(), '{ not json');
    const r = run(['scan', target()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.no-slop\.json/);
    assert.match(r.stderr, /not valid JSON/);
    assert.doesNotMatch(r.stdout, /clean/);
    fs.rmSync(cfg());
  });

  test('an unknown rule id is a hard error naming the file and the id', () => {
    fs.writeFileSync(cfg(), JSON.stringify({ rules: { 'comment-provinance': 'off' } }));
    const r = run(['scan', target()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /comment-provinance/);
    assert.match(r.stderr, /\.no-slop\.json/);
    fs.rmSync(cfg());
  });

  test('an unknown severity is a hard error', () => {
    fs.writeFileSync(cfg(), JSON.stringify({ rules: { 'comment-provenance': 'silent' } }));
    assert.equal(run(['scan', target()]).code, 1);
    fs.rmSync(cfg());
  });

  test('a missing "rules" key is a hard error, not a silent no-op', () => {
    fs.writeFileSync(cfg(), JSON.stringify({ 'comment-provenance': 'off' }));
    const r = run(['scan', target()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rules/);
    fs.rmSync(cfg());
  });

  test('a malformed config also fails the write hook loud', () => {
    fs.writeFileSync(cfg(), '{ not json');
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: target() } }) });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not valid JSON/);
    fs.rmSync(cfg());
  });
});

describe('baseline', () => {
  const baselineFile = () => path.join(dir, '.no-slop-baseline.json');

  test('snapshots existing findings and suppresses them thereafter', () => {
    write('legacy.ts', '// as you requested\nconst userObject = {};\n');
    const payload = JSON.stringify({ tool_input: { file_path: path.join(dir, 'legacy.ts') } });
    assert.equal(run(['write'], { stdin: payload }).code, 2, 'reports before baselining');

    const b = run(['baseline', dir]);
    assert.equal(b.code, 0);
    assert.match(b.stdout, /baselined \d+ existing finding/);
    assert.ok(fs.existsSync(baselineFile()));

    assert.equal(run(['write'], { stdin: payload }).code, 0, 'silent after baselining');
  });

  test('a NEW finding still fires against a baseline', () => {
    fs.appendFileSync(path.join(dir, 'legacy.ts'), '// per your review feedback\n');
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'legacy.ts') } }) });
    assert.equal(r.code, 2);
    assert.equal((r.stderr.match(/comment-provenance/g) ?? []).length, 1, 'only the new one');
  });

  test('a corrupt baseline is a hard error, not a silent all-clear', () => {
    fs.writeFileSync(baselineFile(), '{ nope');
    const r = run(['write'], { stdin: JSON.stringify({ tool_input: { file_path: path.join(dir, 'legacy.ts') } }) });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /baseline/);
    fs.rmSync(baselineFile());
  });
});

describe('cli surface', () => {
  test('--help exits 0', () => assert.equal(run(['--help']).code, 0));
  test('no args prints usage', () => assert.match(run([]).stdout, /no-slop/));
  test('an unknown mode exits 1', () => assert.equal(run(['bogus']).code, 1));
  test('scan with no path is an error', () => assert.equal(run(['scan']).code, 1));
  test('--severity=block hides warns', () => {
    write('warnonly.ts', 'const userObject = {};\n');
    assert.equal(run(['scan', path.join(dir, 'warnonly.ts'), '--severity=block']).code, 0);
    assert.equal(run(['scan', path.join(dir, 'warnonly.ts')]).code, 1);
  });
  test('an invalid --severity is an error', () => {
    assert.equal(run(['scan', dir, '--severity=loud']).code, 1);
  });
  test('--stdin --commit splits on NUL', () => {
    const r = run(['scan', '--stdin', '--commit', '--all'], { stdin: 'wip\0fix null deref in parser\0' });
    assert.match(r.stdout, /message 1/);
    assert.doesNotMatch(r.stdout, /message 2:/);
  });
  test('--stdin --commit without a separator says so', () => {
    const r = run(['scan', '--stdin', '--commit'], { stdin: 'wip\n\nbody\n' });
    assert.match(r.stderr, /NUL separator/);
  });
});

describe('scan honours the baseline', () => {
  test('a baselined finding is hidden from scan and --no-baseline shows it again', () => {
    write('scanbase.ts', '// as you requested\n');
    assert.equal(run(['scan', path.join(dir, 'scanbase.ts')]).code, 1);
    run(['baseline', dir]);
    assert.equal(run(['scan', path.join(dir, 'scanbase.ts')]).code, 0, 'hidden after baseline');
    assert.equal(run(['scan', path.join(dir, 'scanbase.ts'), '--no-baseline']).code, 1, '--no-baseline shows it');
    fs.rmSync(path.join(dir, '.no-slop-baseline.json'));
  });
});

// ---------------------------------------------------------------------------
// commit detection — a table, because this is the highest-risk part of the gate
// ---------------------------------------------------------------------------

describe('commitMessage: invocation shapes', () => {
  const SEES = [
    ['plain', 'git commit -m x', 'x'],
    // `-C <dir>` before `commit` is the directory flag, not --reuse-message.
    // peyra's own CLAUDE.md mandates this form over `cd` chains, so treating it
    // as opaque silently skipped every commit made the documented way.
    ['git -C <dir>', 'git -C /repo/wt-pr1 commit -m x', 'x'],
    // lean-ctx rewrites bash commands to `rtk git …`; \bgit\b still matches.
    ['rtk-rewritten', 'rtk git commit -m x', 'x'],
    ['after cd', 'cd /abs/path && git commit -m x', 'x'],
    ['after a gate chain', 'pnpm run typecheck && pnpm run lint && git commit -m x', 'x'],
    ['amend with -m', 'git commit --amend -m fix', 'fix'],
    // -a commits unstaged worktree changes, so a rule reading `git diff --cached`
    // would see nothing. Detection still fires; the staged-diff hole is documented.
    ['commit -a', 'git commit -a -m x', 'x'],
    ['heredoc', "git commit -m \"$(cat <<'EOF'\nsubject line\n\nbody\nEOF\n)\"", 'subject line\n\nbody'],
  ];

  for (const [name, command, expected] of SEES) {
    test(`sees the message: ${name}`, () => {
      assert.equal(commitMessage(command), expected);
    });
  }

  const BLIND = [
    ['grep, not a commit', 'git log --grep commit'],
    ['dry run has no -m', 'git commit --dry-run'],
    ['quoted, not executed', 'echo "git commit"'],
    ['-C after commit is --reuse-message', 'git commit -C HEAD'],
    ['message from a file', 'git commit -F msg.txt'],
    ['bare commit opens an editor', 'git commit'],
  ];

  for (const [name, command] of BLIND) {
    test(`returns null: ${name}`, () => {
      assert.equal(commitMessage(command), null);
    });
  }
});

describe('write mode: tool input shapes and comment density', () => {
  let d;
  before(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'no-slop-density-'));
    fs.mkdirSync(path.join(d, '.git'));
    fs.writeFileSync(path.join(d, 'heavy.ts'), [
      '// one', '// two', '// three', '// four', '// five', '// six', '// seven',
      'export const a = 1;', 'export const b = 2;',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'lean.ts'), [
      '// the one comment this file needs',
      'export const a = 1;', 'export const b = 2;', 'export const c = 3;',
    ].join('\n'));
    // The shape of a helper consolidation: a function moved into a new file. The
    // scanner sees whole files, so the new home must not read as slop on its own.
    fs.writeFileSync(path.join(d, 'format.ts'), [
      '// `new Date(null)` is the epoch, so the guard is load-bearing.',
      'export function formatDate(d) {',
      "  if (!d) return '—';",
      "  return new Date(d).toLocaleDateString('en-US');",
      '}',
    ].join('\n'));
  });
  after(() => fs.rmSync(d, { recursive: true, force: true }));

  const payload = (tool_name, file) =>
    JSON.stringify({ tool_name, tool_input: { file_path: path.join(d, file) } });

  for (const tool of ['Write', 'Edit']) {
    test(`${tool} on a comment-heavy file reports`, () => {
      const r = run(['write'], { stdin: payload(tool, 'heavy.ts') });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /comment-density/);
      assert.match(r.stderr, /7 comment vs 2 code/);
    });
  }

  test('MultiEdit carries edits[] alongside file_path and still scans', () => {
    const stdin = JSON.stringify({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(d, 'heavy.ts'),
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
    });
    const r = run(['write'], { stdin });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /comment-density/);
  });

  test('a normally-commented file is silent', () => {
    assert.equal(run(['write'], { stdin: payload('Write', 'lean.ts') }).code, 0);
  });

  test('a moved helper in its new file is silent', () => {
    assert.equal(run(['write'], { stdin: payload('Write', 'format.ts') }).code, 0);
  });

  test('baseline grandfathers a historically comment-heavy file', () => {
    assert.equal(run(['write'], { stdin: payload('Write', 'heavy.ts') }).code, 2);
    run(['baseline', '.'], { cwd: d });
    assert.equal(run(['write'], { stdin: payload('Write', 'heavy.ts') }).code, 0);
    fs.rmSync(path.join(d, '.no-slop-baseline.json'));
  });
});

test('generated/ is excluded — ORM clients are never hand-edited', () => {
  // Found by dogfooding: prisma/generated/client.ts tripped comment-density in a
  // real repo. No rule can act on a file nobody edits.
  assert.ok(isExcluded('prisma/generated/client.ts'));
  assert.ok(isExcluded('/abs/src/generated/models/Protocol.ts'));
  assert.ok(!isExcluded('src/generators/report.ts'));
});
