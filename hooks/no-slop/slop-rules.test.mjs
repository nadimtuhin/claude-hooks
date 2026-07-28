import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scan, RULES, RULE_CLASSES, getRule, validateConfig, UnknownRuleError,
  MAX_FILE_LINES, MAX_SUBJECT_LEN,
} from './slop-rules.mjs';

const CODE = ['comment', 'naming'];
const TEST = ['comment', 'naming', 'testfile'];

/** ids fired by scanning `text` under `classes`. */
const ids = (text, classes = CODE, opts = {}) =>
  scan(text, { ruleClasses: classes, ...opts }).findings.map((f) => f.ruleId);

const fires = (id, text, classes = CODE, opts = {}) => ids(text, classes, opts).includes(id);

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

describe('contract', () => {
  test('every rule declares id, classes, severity, message and a concrete fix', () => {
    for (const r of RULES) {
      assert.ok(r.id, 'missing id');
      assert.ok(Array.isArray(r.classes) && r.classes.length, `${r.id}: classes`);
      for (const c of r.classes) assert.ok(RULE_CLASSES.includes(c), `${r.id}: bad class ${c}`);
      assert.ok(['warn', 'block'].includes(r.severity), `${r.id}: severity`);
      assert.ok(r.message?.length > 10, `${r.id}: message`);
      assert.ok(r.fix?.length > 10, `${r.id}: fix`);
      assert.ok(typeof r.match === 'function', `${r.id}: match`);
    }
  });

  test('rule ids are unique', () => {
    assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  });

  test('19 of 28 rules are warn, 9 are block', () => {
    assert.equal(RULES.length, 28);
    assert.equal(RULES.filter((r) => r.severity === 'warn').length, 19);
    assert.equal(RULES.filter((r) => r.severity === 'block').length, 9);
  });

  test('findings are sorted by line, then block-before-warn, then ruleId', () => {
    const src = [
      'function processData() {}',        // 1 naming-vague-generic (off by default)
      '// as you requested',              // 2 comment-provenance (block)
      'const userObject = {};',           // 3 naming-redundant-type-suffix (warn)
    ].join('\n');
    const f = scan(src, { ruleClasses: CODE, config: { 'naming-vague-generic': 'warn' } }).findings;
    const lines = f.map((x) => x.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
    assert.equal(f[0].ruleId, 'naming-vague-generic');
    assert.equal(f[1].severity, 'block');
  });

  test('block sorts before warn on the same line', () => {
    // marketing-superlative (block) + prose-vocabulary-tells (warn) on one line
    const f = scan('This cutting-edge tool lets you delve into logs.', { ruleClasses: ['prose'] }).findings;
    assert.equal(f.length, 2);
    assert.equal(f[0].severity, 'block');
    assert.equal(f[1].severity, 'warn');
  });

  test('exact (line, ruleId, excerpt) repeats are deduped', () => {
    const f = scan('// as you requested', { ruleClasses: CODE }).findings
      .filter((x) => x.ruleId === 'comment-provenance');
    assert.equal(f.length, 1);
  });

  test('multiple distinct rules on one line all report', () => {
    const src = 'const EnhancedManagerService = 1; // as you asked';
    const got = new Set(ids(src));
    assert.ok(got.has('naming-inflated'));
    assert.ok(got.has('naming-doubled-role'));
    assert.ok(got.has('comment-provenance'));
  });

  test('findings carry line, excerpt, message and fix', () => {
    const [f] = scan('// as you requested', { ruleClasses: CODE }).findings;
    assert.equal(f.line, 1);
    assert.ok(f.excerpt.length);
    assert.ok(f.fix.length);
    assert.equal(f.severity, 'block');
  });
});

// ---------------------------------------------------------------------------
// ruleClasses gate
// ---------------------------------------------------------------------------

describe('ruleClasses gate', () => {
  test('comment rules do not run without the comment class', () => {
    assert.ok(fires('comment-provenance', '// as you requested', ['comment']));
    assert.ok(!fires('comment-provenance', '// as you requested', ['naming']));
  });

  test('testfile rules do not run on non-test files', () => {
    const src = "it.skip('x', () => {});";
    assert.ok(fires('testfile-unconditional-skip', src, TEST));
    assert.ok(!fires('testfile-unconditional-skip', src, CODE));
  });

  test('prose rules never run on commit text', () => {
    // "delve" in a commit body must not fire the prose vocabulary rule.
    assert.ok(!fires('prose-vocabulary-tells', 'fix parser\n\nlet us delve into it', ['commit']));
    assert.ok(fires('prose-vocabulary-tells', 'let us delve into it', ['prose']));
  });

  test('commit rules never run on file writes', () => {
    const long = 'a'.repeat(120);
    assert.ok(fires('commit-subject-too-long', long, ['commit']));
    assert.ok(!fires('commit-subject-too-long', long, CODE));
  });

  test('marketing-superlative runs in both commit and prose', () => {
    assert.ok(fires('marketing-superlative', 'add cutting-edge parser', ['commit']));
    assert.ok(fires('marketing-superlative', 'a cutting-edge parser', ['prose']));
    assert.ok(!fires('marketing-superlative', '// a cutting-edge parser', CODE));
  });

  test('empty ruleClasses fires nothing', () => {
    assert.deepEqual(ids('// as you requested\nit.only("x", () => {})', []), []);
  });
});

// ---------------------------------------------------------------------------
// comment class
// ---------------------------------------------------------------------------

describe('comment-provenance', () => {
  const yes = [
    '// as you requested, this now returns null',
    '# per your review feedback',
    '// Addressing the review comments here',
    '-- as we discussed offline',
    '// in response to your feedback, split the loop',
    '// you asked for a retry, so here it is',
    '// per our discussion',
    '  * based on your feedback',
  ];
  for (const [i, src] of yes.entries()) {
    test(`fires ${i}: ${src.trim()}`, () => assert.ok(fires('comment-provenance', src)));
  }

  const no = [
    '// the caller may pass null; the guard below is load-bearing',
    '// retries three times because the upstream 502s under load',
    '// requested is the field name the API returns',
    'const requested = true; // set by the caller',
    '// asked and answered is a legal term, not provenance',
  ];
  for (const [i, src] of no.entries()) {
    test(`quiet ${i}: ${src.trim()}`, () => assert.ok(!fires('comment-provenance', src)));
  }

  test('ticket reference downgrades to the ticketed subclass', () => {
    const src = '// as you requested, see #412';
    assert.ok(!fires('comment-provenance', src));
    assert.ok(fires('comment-provenance-ticketed', src));
  });

  test('URL reference downgrades too', () => {
    const src = '// per your review https://github.com/o/r/pull/1#discussion_r1';
    assert.ok(fires('comment-provenance-ticketed', src));
    assert.ok(!fires('comment-provenance', src));
  });

  test('JIRA-style key downgrades too', () => {
    assert.ok(fires('comment-provenance-ticketed', '// as discussed, ABC-123'));
  });

  test('provenance in a string literal is not a comment', () => {
    assert.ok(!fires('comment-provenance', 'const msg = "as you requested";'));
  });
});

describe('comment-narration-generic-steps', () => {
  test('two markers within 40 lines fire once, at the first', () => {
    const src = ['// Step 1: load the config', 'load();', '// Step 2: validate it', 'check();'].join('\n');
    const f = scan(src, { ruleClasses: CODE }).findings.filter((x) => x.ruleId === 'comment-narration-generic-steps');
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 1);
  });

  test('a single marker is ordinary prose and stays quiet', () => {
    assert.ok(!fires('comment-narration-generic-steps', '// First, the lock has to be released\ndoIt();'));
  });

  test('markers more than 40 lines apart do not group', () => {
    const src = ['// First, load', ...Array(50).fill('noop();'), '// Then, save'].join('\n');
    assert.ok(!fires('comment-narration-generic-steps', src));
  });

  test('boundary: exactly 40 lines apart still groups', () => {
    const src = ['// First, load', ...Array(39).fill('noop();'), '// Then, save'].join('\n');
    assert.ok(fires('comment-narration-generic-steps', src));
  });

  test('python hash markers fire', () => {
    assert.ok(fires('comment-narration-generic-steps', '# Step 1: open\n# Step 2: read', CODE, { lang: 'py' }));
  });
});

describe('comment-restates-code', () => {
  test('fires when the comment words are a subset of the next line', () => {
    assert.ok(fires('comment-restates-code', '// set the user name\nsetUserName(x);'));
  });
  test('fires on return-the-result', () => {
    assert.ok(fires('comment-restates-code', '// return the result\nreturn result;'));
  });
  test('quiet when the comment adds information', () => {
    assert.ok(!fires('comment-restates-code', '// upstream 502s under load, so retry\nreturn result;'));
  });
  test('quiet for a one-word comment', () => {
    assert.ok(!fires('comment-restates-code', '// result\nreturn result;'));
  });
  test('quiet when the comment is long enough to be doing work', () => {
    assert.ok(!fires('comment-restates-code', '// set the user name from the parsed token payload claim\nsetUserNameFromTheParsedTokenPayloadClaim(x);'));
  });
});

describe('comment-section-banner / comment-obvious-label', () => {
  test('banner fires', () => assert.ok(fires('comment-section-banner', '// ==============================')));
  test('short rule does not fire', () => assert.ok(!fires('comment-section-banner', '// ---')));
  test('boundary: 8 characters fires', () => assert.ok(fires('comment-section-banner', '// ========')));
  test('boundary: 7 characters does not', () => assert.ok(!fires('comment-section-banner', '// =======')));

  for (const label of ['// Constructor', '# Imports', '// Getters:', '// Helper functions', '// Config section']) {
    test(`obvious label fires: ${label}`, () => assert.ok(fires('comment-obvious-label', label, CODE, { lang: 'py' })));
  }
  test('a label that says something stays quiet', () => {
    assert.ok(!fires('comment-obvious-label', '// Constructor takes an already-open handle'));
  });
});

// ---------------------------------------------------------------------------
// naming class
// ---------------------------------------------------------------------------

describe('naming', () => {
  test('inflated adjectives fire', () => {
    assert.ok(fires('naming-inflated', 'class EnhancedParser {}'));
    assert.ok(fires('naming-inflated', 'const smartCache = new Map();'));
    assert.ok(fires('naming-inflated', 'def robust_thing(): pass')); // snake_case too
  });
  test('a legitimate name is quiet', () => {
    assert.ok(!fires('naming-inflated', 'class StreamingParser {}'));
    assert.ok(!fires('naming-inflated', 'const advanced = true;')); // no CamelCase tail
  });

  test('doubled role suffix fires', () => {
    assert.ok(fires('naming-doubled-role', 'class ProfileManagerService {}'));
    assert.ok(fires('naming-doubled-role', 'class QueueHandlerHandler {}'));
  });
  test('single role suffix is quiet', () => {
    assert.ok(!fires('naming-doubled-role', 'class ProfileManager {}'));
  });

  test('versioned suffix fires', () => {
    assert.ok(fires('naming-versioned-suffix', 'function parseConfigV2() {}'));
    assert.ok(fires('naming-versioned-suffix', 'const clientV3 = 1;'));
  });
  test('a name merely containing "new" is quiet', () => {
    assert.ok(!fires('naming-versioned-suffix', 'function newParser() {}'));
  });

  test('redundant type suffix fires', () => {
    assert.ok(fires('naming-redundant-type-suffix', 'const userObject = {};'));
    assert.ok(fires('naming-redundant-type-suffix', 'let nameString = "x";'));
  });
  test('list/array suffixes are legitimate and stay quiet', () => {
    assert.ok(!fires('naming-redundant-type-suffix', 'const userList = [];'));
    assert.ok(!fires('naming-redundant-type-suffix', 'const idsArray = [];'));
  });

  test('naming-vague-generic is off by default', () => {
    assert.ok(!fires('naming-vague-generic', 'function processData() {}'));
  });
  test('naming-vague-generic fires once enabled', () => {
    assert.ok(fires('naming-vague-generic', 'function processData() {}', CODE, { config: { 'naming-vague-generic': 'warn' } }));
  });

  test('names inside a full-line comment are not declarations', () => {
    assert.ok(!fires('naming-inflated', '// class EnhancedParser {}'));
  });
});

// ---------------------------------------------------------------------------
// testfile class
// ---------------------------------------------------------------------------

describe('testfile-unconditional-skip', () => {
  test('string-literal skip fires', () => {
    assert.ok(fires('testfile-unconditional-skip', "it.skip('adds', () => {});", TEST));
    assert.ok(fires('testfile-unconditional-skip', 'describe.skip("suite", () => {});', TEST));
    assert.ok(fires('testfile-unconditional-skip', "xit('adds', () => {});", TEST));
  });
  test("Playwright's conditional test.skip(cond, reason) is legitimate and quiet", () => {
    assert.ok(!fires('testfile-unconditional-skip', 'test.skip(isCI, "flaky on CI");', TEST));
    assert.ok(!fires('testfile-unconditional-skip', 'test.skip(({ browserName }) => browserName === "webkit");', TEST));
    assert.ok(!fires('testfile-unconditional-skip', 'test.skip();', TEST));
  });
  test('a plain test is quiet', () => {
    assert.ok(!fires('testfile-unconditional-skip', "it('adds', () => { expect(1).toBe(1); });", TEST));
  });
});

describe('testfile-only', () => {
  test('fires', () => {
    assert.ok(fires('testfile-only', "it.only('x', () => {});", TEST));
    assert.ok(fires('testfile-only', "fdescribe('x', () => {});", TEST));
  });
  test('a method genuinely named only is quiet', () => {
    assert.ok(!fires('testfile-only', 'const v = rows.only;', TEST));
  });
});

describe('testfile-empty-body / no-assertions', () => {
  test('empty body fires', () => {
    assert.ok(fires('testfile-empty-body', "it('adds two numbers', () => {});", TEST));
  });
  test('comment-only body still counts as empty', () => {
    assert.ok(fires('testfile-empty-body', "it('adds', () => {\n  // TODO\n});", TEST));
  });
  test('a body with an assertion is clean', () => {
    const src = "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});";
    assert.ok(!fires('testfile-empty-body', src, TEST));
    assert.ok(!fires('testfile-no-assertions', src, TEST));
  });
  test('statements without assertions warn', () => {
    const src = "it('adds', () => {\n  add(1, 2);\n});";
    assert.ok(!fires('testfile-empty-body', src, TEST));
    assert.ok(fires('testfile-no-assertions', src, TEST));
  });
  test('async arrow bodies are handled', () => {
    assert.ok(fires('testfile-empty-body', "it('adds', async () => {});", TEST));
  });
});

describe('testfile-tautology', () => {
  test('expect(x).toBe(x) fires', () => {
    assert.ok(fires('testfile-tautology', 'expect(result).toBe(result);', TEST));
  });
  test('assert.equal(x, x) fires', () => {
    assert.ok(fires('testfile-tautology', 'assert.equal(total, total);', TEST));
  });
  test('a real assertion is quiet', () => {
    assert.ok(!fires('testfile-tautology', 'expect(result).toBe(42);', TEST));
    assert.ok(!fires('testfile-tautology', 'assert.equal(total, expected);', TEST));
  });
  test('whitespace differences still count as self-comparison', () => {
    assert.ok(fires('testfile-tautology', 'expect( result ).toBe(result);', TEST));
  });
});

describe('testfile-vague-name', () => {
  for (const t of ["it('works', () => { expect(1).toBe(1); });", "it('should work', () => { expect(1).toBe(1); });", "test('basic', () => { expect(1).toBe(1); });"]) {
    test(`fires: ${t.slice(0, 24)}`, () => assert.ok(fires('testfile-vague-name', t, TEST)));
  }
  test('a behavioural title is quiet', () => {
    assert.ok(!fires('testfile-vague-name', "it('returns 404 when the id is unknown', () => { expect(1).toBe(1); });", TEST));
  });
});

// ---------------------------------------------------------------------------
// commit class
// ---------------------------------------------------------------------------

describe('commit', () => {
  test(`${MAX_SUBJECT_LEN} chars is fine, ${MAX_SUBJECT_LEN + 1} blocks`, () => {
    assert.ok(!fires('commit-subject-too-long', 'x'.repeat(MAX_SUBJECT_LEN), ['commit']));
    assert.ok(fires('commit-subject-too-long', 'x'.repeat(MAX_SUBJECT_LEN + 1), ['commit']));
  });
  test('a conventional-commit subject with a ticket list is not blocked', () => {
    // The real-corpus shape the 72-char ceiling would have rejected.
    const s = 'fix(renderer): add try/catch to bulk handlers, guard double-click (ABC-784, ABC-776)';
    assert.ok(s.length > 72 && s.length <= MAX_SUBJECT_LEN);
    assert.ok(!fires('commit-subject-too-long', s, ['commit']));
  });
  test('a long body line does not trip the subject rule', () => {
    assert.ok(!fires('commit-subject-too-long', `fix parser\n\n${'x'.repeat(200)}`, ['commit']));
  });

  test('trailing period blocks', () => {
    assert.ok(fires('commit-subject-trailing-period', 'fix the parser.', ['commit']));
  });
  test('an ellipsis is not a trailing period', () => {
    assert.ok(!fires('commit-subject-trailing-period', 'fix the parser...', ['commit']));
  });
  test('a version number mid-subject is fine', () => {
    assert.ok(!fires('commit-subject-trailing-period', 'chore(release): v0.1.10', ['commit']));
  });

  for (const s of ['wip', 'misc', 'updates', 'cleanup', 'fix stuff', 'various changes to the parser']) {
    test(`filler fires: ${s}`, () => assert.ok(fires('commit-filler', s, ['commit'])));
  }
  test('a specific subject is quiet', () => {
    assert.ok(!fires('commit-filler', 'fix null deref in the profile lock reaper', ['commit']));
  });

  test('provenance in a commit body warns', () => {
    assert.ok(fires('commit-provenance', 'fix parser\n\nAddressing review feedback from the last round', ['commit']));
  });
  test('harness trailers are exempt', () => {
    const msg = [
      'fix null deref in parser',
      '',
      'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
      'Claude-Session: https://claude.ai/code/session_x',
    ].join('\n');
    assert.deepEqual(ids(msg, ['commit']), []);
  });

  test('body narration heading warns', () => {
    assert.ok(fires('commit-body-narration', 'fix parser\n\nChanges made:\n- one', ['commit']));
  });
  test('a subject starting with "this commit" does not double-report on line 1', () => {
    const f = scan('This commit adds x', { ruleClasses: ['commit'] }).findings;
    assert.ok(!f.some((x) => x.ruleId === 'commit-body-narration'));
  });

  test('marketing blocks a commit', () => {
    assert.ok(fires('marketing-superlative', 'Add cutting-edge parser', ['commit']));
    assert.ok(fires('marketing-superlative', 'add best-in-class retries', ['commit']));
  });
  test('a plain commit is completely clean', () => {
    assert.deepEqual(ids('fix null deref in parser', ['commit']), []);
  });
});

// ---------------------------------------------------------------------------
// prose class
// ---------------------------------------------------------------------------

describe('prose', () => {
  for (const s of ["You're absolutely right — the lock leaks.", 'Great question!', 'Certainly! Here is the patch.', 'I apologize for the confusion.', 'Perfect! That works.']) {
    test(`opener blocks: ${s.slice(0, 22)}`, () => assert.ok(fires('prose-opener', s, ['prose'])));
  }
  test('an opener mid-sentence is quiet', () => {
    assert.ok(!fires('prose-opener', 'The maintainer said you are right about the lock.', ['prose']));
  });

  test('vocabulary tells warn', () => {
    assert.ok(fires('prose-vocabulary-tells', 'Let me delve into the logs.', ['prose']));
    assert.ok(fires('prose-vocabulary-tells', 'a seamless migration path', ['prose']));
  });
  test('dropped words stay dropped', () => {
    for (const w of ['crucial', 'pivotal', 'underscore', 'landscape']) {
      assert.ok(!fires('prose-vocabulary-tells', `this is ${w} to the design`, ['prose']), w);
    }
  });

  test('negative parallelism warns', () => {
    assert.ok(fires('prose-negative-parallelism', "It's not just a cache, it's a write-through log.", ['prose']));
  });
  test('an ordinary negation is quiet', () => {
    assert.ok(!fires('prose-negative-parallelism', 'It is not a cache. Reads go straight to disk.', ['prose']));
  });
  test('prose-hedge-stack was dropped and no rule replaced it', () => {
    assert.equal(getRule('prose-hedge-stack'), undefined);
    assert.ok(!fires('prose-hedge-stack', 'It might possibly perhaps be a race.', ['prose']));
  });
});

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

describe('pragma suppression', () => {
  test('same-line pragma suppresses the named rule', () => {
    assert.ok(!fires('comment-provenance', '// as you requested  slop-ok: comment-provenance'));
  });

  test('pragma one line above suppresses', () => {
    const src = '// slop-ok: naming-inflated\nclass EnhancedParser {}';
    assert.ok(!fires('naming-inflated', src));
  });

  test('pragma TWO lines above does NOT suppress', () => {
    const src = '// slop-ok: naming-inflated\nconst x = 1;\nclass EnhancedParser {}';
    assert.ok(fires('naming-inflated', src));
  });

  test('a pragma for a different rule does not suppress', () => {
    const src = '// slop-ok: naming-doubled-role\nclass EnhancedParser {}';
    assert.ok(fires('naming-inflated', src));
  });

  test('a comma list suppresses each named rule', () => {
    const src = '// slop-ok: naming-inflated, naming-doubled-role\nclass EnhancedManagerService {}';
    const got = ids(src);
    assert.ok(!got.includes('naming-inflated'));
    assert.ok(!got.includes('naming-doubled-role'));
  });

  test('a bare slop-ok suppresses nothing and reports itself', () => {
    const src = '// slop-ok\nclass EnhancedParser {}';
    const got = ids(src);
    assert.ok(got.includes('naming-inflated'), 'must still fire');
    assert.ok(got.includes('pragma-bare'), 'must report the bare pragma');
  });

  // One sample per rule that must trigger it. This table is the centralized
  // replacement for 26 copy-pasted per-rule pragma tests, and doubles as the
  // positive-coverage floor: a rule that stops firing here fails the sweep.
  const SAMPLES = {
    'comment-provenance': [CODE, '// as you requested'],
    'comment-provenance-ticketed': [CODE, '// as you requested, see #412'],
    'comment-narration-generic-steps': [CODE, '// Step 1: load\n// Step 2: save'],
    'comment-restates-code': [CODE, '// return the result\nreturn result;'],
    'comment-section-banner': [CODE, '// =========='],
    'comment-obvious-label': [CODE, '// Constructor'],
    'naming-inflated': [CODE, 'class EnhancedParser {}'],
    'naming-doubled-role': [CODE, 'class ProfileManagerService {}'],
    'naming-versioned-suffix': [CODE, 'function parseConfigV2() {}'],
    'naming-redundant-type-suffix': [CODE, 'const userObject = {};'],
    'naming-vague-generic': [CODE, 'function processData() {}', { 'naming-vague-generic': 'warn' }],
    'testfile-unconditional-skip': [TEST, "it.skip('adds', () => {});"],
    'testfile-only': [TEST, "it.only('adds', () => { expect(1).toBe(2); });"],
    'testfile-empty-body': [TEST, "it('adds two things', () => {});"],
    'testfile-no-assertions': [TEST, "it('adds two things', () => {\n  add(1);\n});"],
    'testfile-tautology': [TEST, 'expect(result).toBe(result);'],
    'testfile-vague-name': [TEST, "it('works', () => { expect(1).toBe(2); });"],
    'testfile-duplicate-body': [
      TEST,
      "it('adds one', () => {\n  const r = add(1);\n  expect(r).toBe(1);\n  expect(r).toBeGreaterThan(0);\n});\n" +
        "it('adds two', () => {\n  const r = add(2);\n  expect(r).toBe(2);\n  expect(r).toBeGreaterThan(0);\n});",
    ],
    'commit-subject-too-long': [['commit'], 'x'.repeat(120)],
    'commit-subject-trailing-period': [['commit'], 'fix the parser.'],
    'commit-filler': [['commit'], 'wip'],
    'commit-provenance': [['commit'], 'fix parser\n\nAddressing review feedback'],
    'commit-body-narration': [['commit'], 'fix parser\n\nChanges made:\n- x'],
    'comment-density': [['comment'], '// a\n// b\n// c\n// d\n// e\n// f\n// g\nconst x = 1;'],
    'marketing-superlative': [['prose'], 'notes\na cutting-edge parser'],
    'prose-opener': [['prose'], 'notes\nGreat question!'],
    'prose-vocabulary-tells': [['prose'], 'notes\nLet me delve into the logs.'],
    'prose-negative-parallelism': [['prose'], "notes\nIt's not just a cache, it's a log."],
  };

  // A finding pinned to line 1 has no line above it to carry a pragma, and a
  // same-line pragma would alter the very text being judged. Those are
  // suppressible through .no-slop.json only.
  const CONFIG_ONLY = new Set(['commit-subject-too-long', 'commit-subject-trailing-period', 'commit-filler']);

  test('every rule has a sample', () => {
    assert.deepEqual(RULES.map((r) => r.id).filter((id) => !SAMPLES[id]), []);
  });

  for (const r of RULES) {
    const [classes, sample, config = {}] = SAMPLES[r.id];
    // A commit message's line 1 is load-bearing; everything else gets a neutral
    // anchor line so the finding lands on line 2+ and has a pragma slot above it.
    const src = classes.includes('commit') ? sample : `const __anchor = 1;\n${sample}`;

    test(`${r.id}: sample fires`, () => {
      assert.ok(ids(src, classes, { config }).includes(r.id));
    });

    if (CONFIG_ONLY.has(r.id)) {
      test(`${r.id}: suppressed by config (line-1 finding, no pragma slot)`, () => {
        assert.ok(!ids(src, classes, { config: { ...config, [r.id]: 'off' } }).includes(r.id));
      });
      continue;
    }

    test(`${r.id}: pragma on the line above suppresses it`, () => {
      const line = scan(src, { ruleClasses: classes, config }).findings.find((f) => f.ruleId === r.id).line;
      assert.ok(line > 1, `${r.id} fired on line 1; add it to CONFIG_ONLY`);
      const lines = src.split('\n');
      lines.splice(line - 1, 0, `// slop-ok: ${r.id}`);
      assert.ok(!ids(lines.join('\n'), classes, { config }).includes(r.id));
    });
  }
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe('config', () => {
  test('"off" disables a rule', () => {
    assert.ok(!fires('comment-provenance', '// as you requested', CODE, { config: { 'comment-provenance': 'off' } }));
  });

  test('"warn" demotes a block rule', () => {
    const [f] = scan('// as you requested', { ruleClasses: CODE, config: { 'comment-provenance': 'warn' } }).findings;
    assert.equal(f.severity, 'warn');
  });

  test('"block" promotes a warn rule', () => {
    const f = scan('class ProfileManagerService {}', { ruleClasses: CODE, config: { 'naming-doubled-role': 'block' } }).findings;
    assert.equal(f[0].severity, 'block');
  });

  test('an unknown rule id throws instead of being ignored', () => {
    assert.throws(() => validateConfig({ 'comment-provinance': 'off' }), UnknownRuleError);
    assert.throws(() => scan('x', { ruleClasses: CODE, config: { nope: 'off' } }), UnknownRuleError);
  });

  test('an unknown level throws', () => {
    assert.throws(() => validateConfig({ 'comment-provenance': 'silent' }), UnknownRuleError);
  });

  test('the error names the offending file', () => {
    assert.throws(() => validateConfig({ nope: 'off' }, 'pkg/.no-slop.json'), /pkg\/\.no-slop\.json/);
  });
});

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

describe('size and time gates', () => {
  test(`over ${MAX_FILE_LINES} lines: one warn, no rules run`, () => {
    const src = Array(MAX_FILE_LINES + 1).fill('// as you requested').join('\n');
    const f = scan(src, { ruleClasses: CODE }).findings;
    assert.equal(f.length, 1);
    assert.equal(f[0].ruleId, 'file-too-large');
  });

  test(`exactly ${MAX_FILE_LINES} lines still scans`, () => {
    const src = Array(MAX_FILE_LINES).fill('const ok = 1;').join('\n');
    assert.deepEqual(scan(src, { ruleClasses: CODE }).findings, []);
  });

  test('over 150KB gates even when short', () => {
    const src = ['const x = 1;', 'y'.repeat(160 * 1024)].join('\n');
    assert.equal(scan(src, { ruleClasses: CODE }).findings[0].ruleId, 'file-too-large');
  });

  test('a line over 2000 chars is skipped before regex', () => {
    const src = `const x = "${'a'.repeat(2100)}"; // as you requested`;
    assert.deepEqual(scan(src, { ruleClasses: CODE }).findings, []);
  });

  test('the time budget truncates rather than hanging', () => {
    let t = 0;
    const now = () => (t += 1000); // every check blows the budget
    const src = Array(1200).fill('// as you requested').join('\n');
    const r = scan(src, { ruleClasses: CODE, budgetMs: 200, now });
    assert.ok(r.truncated !== null, 'reports the truncation line');
  });

  test('a clean file produces no findings at all', () => {
    const src = [
      'export function parseInvoice(raw) {',
      '  // amounts arrive as minor units; the API never sends decimals',
      '  return { cents: Number(raw.amount) };',
      '}',
    ].join('\n');
    assert.deepEqual(scan(src, { ruleClasses: RULE_CLASSES }).findings, []);
  });
});

// ---------------------------------------------------------------------------
// multi-language
// ---------------------------------------------------------------------------

describe('multi-language comments', () => {
  test('python hash', () => assert.ok(fires('comment-provenance', '# as you requested', CODE, { lang: 'py' })));
  test('shell hash', () => assert.ok(fires('comment-provenance', '# per your review', CODE, { lang: 'sh' })));
  test('sql double dash', () => assert.ok(fires('comment-provenance', '-- as you requested', CODE, { lang: 'sql' })));
  test('jsdoc star', () => assert.ok(fires('comment-provenance', ' * as you requested', CODE, { lang: 'ts' })));
  test('block comment opener', () => assert.ok(fires('comment-provenance', '/* as you requested */', CODE, { lang: 'ts' })));
  test('trailing js comment', () => assert.ok(fires('comment-provenance', 'const x = 1; // as you requested', CODE, { lang: 'ts' })));
  test('a hash inside a JS template string is not a comment', () => {
    assert.ok(!fires('comment-provenance', 'const u = `${base}#as you requested`;', CODE, { lang: 'ts' }));
  });
});

describe('testfile-tautology regressions from the real-repo sweep', () => {
  test('a property compared to a same-named variable is not a self-comparison', () => {
    assert.ok(!fires('testfile-tautology', 'expect(rows.find((m) => m.id === id).actions).toEqual({ a: 1 });', TEST));
  });
  test('expect(true).toBe(true) is still caught', () => {
    assert.ok(fires('testfile-tautology', 'expect(true).toBe(true);', TEST));
  });
  test('a real self-comparison is still caught', () => {
    assert.ok(fires('testfile-tautology', 'expect(total === total).toBe(true);', TEST));
  });
});

describe('divider regressions from the real-repo sweep', () => {
  test('a labelled box-drawing divider is not restatement', () => {
    const src = ['// ─── checkMessages ─────', "describe('checkMessages', () => {"].join('\n');
    assert.ok(!fires('comment-restates-code', src, TEST));
    assert.ok(!fires('comment-section-banner', src, TEST));
  });
  test('a labelled ASCII divider is not restatement either', () => {
    const src = ['// --- parse invoice ---------', 'function parseInvoice() {}'].join('\n');
    assert.ok(!fires('comment-restates-code', src));
    assert.ok(!fires('comment-section-banner', src));
  });
  test('an unlabelled box-drawing ruler is still a banner', () => {
    assert.ok(fires('comment-section-banner', '// ──────────'));
  });
  test('plain restatement still fires', () => {
    assert.ok(fires('comment-restates-code', '// set the user name\nsetUserName(x);'));
  });
});

describe('naming precision regressions from the real-repo sweep', () => {
  const quiet = ['function openNew() {}', 'function handleCopy() {}', 'function seedLegacy() {}',
    'const twoHoursOld = 1;', 'function downloadImageToTemp() {}'];
  for (const src of quiet) {
    test(`versioned-suffix quiet: ${src}`, () => assert.ok(!fires('naming-versioned-suffix', src)));
  }
  test('a numeric version suffix still fires', () => {
    assert.ok(fires('naming-versioned-suffix', 'function parseConfigV2() {}'));
  });

  const verbLed = ['function assertString(x) {}', 'function parseSqliteBoolean(x) {}', 'function randomInt() {}'];
  for (const src of verbLed) {
    test(`type-suffix quiet: ${src}`, () => assert.ok(!fires('naming-redundant-type-suffix', src)));
  }
  test('a numeral suffix is not a type suffix', () => {
    assert.ok(!fires('naming-redundant-type-suffix', 'const dealerNumber = 7;'));
  });
  test('the canonical redundant suffix still fires', () => {
    assert.ok(fires('naming-redundant-type-suffix', 'const userObject = {};'));
    assert.ok(fires('naming-redundant-type-suffix', 'const nameString = "x";'));
  });

  test('a short bookended divider is not restatement', () => {
    assert.ok(!fires('comment-restates-code', '// --- Mark read ---\nfunction markRead() {}'));
  });
});

describe('literal truthiness assertions', () => {
  test('expect(true).toBeTruthy() is always green', () => {
    assert.ok(fires('testfile-tautology', 'expect(true).toBeTruthy();', TEST));
  });
  test('a real value asserted truthy is fine', () => {
    assert.ok(!fires('testfile-tautology', 'expect(result.ok).toBeTruthy();', TEST));
  });
});

describe('pragmas only count inside comments', () => {
  test('prose mentioning slop-ok is not a bare pragma', () => {
    assert.ok(!ids('A bare `slop-ok` suppresses nothing.', ['prose']).includes('pragma-bare'));
  });
  test('a string literal containing a pragma does not suppress', () => {
    const src = ['const help = "slop-ok: naming-inflated";', 'class EnhancedParser {}'].join('\n');
    assert.ok(fires('naming-inflated', src));
  });
  test('an HTML comment pragma works in markdown', () => {
    const src = ['<!-- slop-ok: marketing-superlative -->', 'a cutting-edge parser'].join('\n');
    assert.ok(!fires('marketing-superlative', src, ['prose'], { lang: 'md' }));
  });
  test('a real comment pragma still suppresses', () => {
    assert.ok(!fires('naming-inflated', '// slop-ok: naming-inflated\nclass EnhancedParser {}'));
  });
});

describe('section banner: labelled blocks are navigation, not noise', () => {
  test('a three-line labelled block is quiet', () => {
    const src = ['// ==========================', '// small helpers', '// =========================='].join('\n');
    assert.ok(!fires('comment-section-banner', src));
  });
  test('a lone unlabelled ruler still fires', () => {
    assert.ok(fires('comment-section-banner', 'const a = 1;\n// ==========================\nconst b = 2;'));
  });
  test('a ruler followed by code is still a bare ruler', () => {
    assert.ok(fires('comment-section-banner', '// ==========================\nfunction go() {}'));
  });
})

describe('comment-density', () => {
  const heavy = [
    '// one', '// two', '// three', '// four', '// five', '// six', '// seven',
    'const a = 1;',
    'const b = 2;',
  ].join('\n');

  const lean = [
    '// one', '// two', '// three', '// four', '// five', '// six',
    'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;',
    'const e = 5;', 'const f = 6;', 'const g = 7;',
  ].join('\n');

  test('fires when comment lines outnumber code lines', () => {
    assert.ok(fires('comment-density', heavy, CODE, { lang: 'ts' }));
  });

  test('silent when code outnumbers comments', () => {
    assert.ok(!fires('comment-density', lean, CODE, { lang: 'ts' }));
  });

  test('silent below the minimum comment count', () => {
    // 3 comments / 2 code is comment-heavy by ratio but too small to mean anything.
    const tiny = '// a\n// b\n// c\nconst a = 1;\nconst b = 2;';
    assert.ok(!fires('comment-density', tiny, CODE, { lang: 'ts' }));
  });

  test('blank lines count as neither', () => {
    const spaced = heavy.split('\n').join('\n\n');
    assert.ok(fires('comment-density', spaced, CODE, { lang: 'ts' }));
  });

  test('exempt on test files', () => {
    assert.ok(!fires('comment-density', heavy, TEST, { lang: 'ts' }));
  });

  test('exempt for markdown and shell, where the ratio is the convention', () => {
    for (const lang of ['md', 'sh', 'bash']) {
      assert.ok(!fires('comment-density', heavy, CODE, { lang }), lang);
    }
  });

  test('fires once, and the excerpt names the lines it counted', () => {
    const found = scan(heavy, { ruleClasses: CODE, lang: 'ts' }).findings
      .filter((f) => f.ruleId === 'comment-density');
    assert.equal(found.length, 1);
    assert.match(found[0].excerpt, /7 comment vs 2 code; lines 1-7/);
  });

  test('trailing comments count as code, not comment', () => {
    const trailing = [
      'const a = 1; // set a', 'const b = 2; // set b', 'const c = 3; // set c',
      'const d = 4; // set d', 'const e = 5; // set e', 'const f = 6; // set f',
      'const g = 7; // set g',
    ].join('\n');
    assert.ok(!fires('comment-density', trailing, CODE, { lang: 'ts' }));
  });

  test('respects an off override', () => {
    assert.ok(!fires('comment-density', heavy, CODE, {
      lang: 'ts', config: { 'comment-density': 'off' },
    }));
  });
});

// ---------------------------------------------------------------------------
// markdown fences
// ---------------------------------------------------------------------------

describe('markdown fenced blocks are not scanned', () => {
  const fenced = [
    'Some prose about the parser.',
    '```js',
    '// return the result',
    'return result;',
    'class EnhancedParser {}',
    'const userObject = {};',
    '```',
    'More prose.',
  ].join('\n');

  test('no findings of any class inside a fence', () => {
    assert.deepEqual(ids(fenced, CODE, { lang: 'md' }), []);
  });

  test('naming rules are gated too, not just comment rules', () => {
    // The tempting fix was to gate `comment` rules on lang; nameRule has no lang
    // gate either, so that would have left half the bug live.
    assert.ok(!fires('naming-inflated', fenced, CODE, { lang: 'md' }));
    assert.ok(!fires('naming-redundant-type-suffix', fenced, CODE, { lang: 'md' }));
  });

  test('the same text in a .ts file still fires', () => {
    const got = ids(fenced.split('\n').slice(2, 6).join('\n'), CODE, { lang: 'ts' });
    assert.ok(got.includes('comment-restates-code'));
    assert.ok(got.includes('naming-inflated'));
  });

  test('line numbers outside the fence are unchanged', () => {
    // Interiors are blanked in place, never spliced — baseline keys are line:ruleId,
    // so a splice would shift every later number and void every .md baseline entry.
    const src = [
      'class EnhancedParser {}',   // 1 — prose, still scanned
      'text',                      // 2
      '```',                       // 3
      'class EnhancedWidget {}',   // 4 — fenced, must be silent
      '```',                       // 5
      'class EnhancedThing {}',    // 6 — prose again, line must still read 6
    ].join('\n');
    const got = scan(src, { ruleClasses: CODE, lang: 'md' }).findings
      .filter((f) => f.ruleId === 'naming-inflated');
    assert.deepEqual(got.map((f) => f.line), [1, 6]);
  });

  test('markdown headings and list items are not comments', () => {
    // `#` and `*` are in COMMENT_START for real languages, so without a md-specific
    // pattern every README heading reads as a comment. This is what fired repeatedly
    // on peyra's README while the branch work was in progress.
    const heading = ['## Commit signing', 'Sign commits with a key.'].join('\n');
    assert.deepEqual(ids(heading, CODE, { lang: 'md' }), []);

    const bullets = ['* the enhanced parser', '- as you requested'].join('\n');
    assert.deepEqual(ids(bullets, CODE, { lang: 'md' }), []);

    // The same leading `#` in a shell script IS a comment and still fires.
    const sh = ['# return the result', 'return result'].join('\n');
    assert.ok(fires('comment-restates-code', sh, CODE, { lang: 'sh' }));
    assert.ok(!fires('comment-restates-code', sh, CODE, { lang: 'md' }));
  });

  test('an HTML comment in markdown is still a comment', () => {
    assert.ok(fires('comment-provenance', '<!-- as you requested -->', CODE, { lang: 'md' }));
  });

  test('a longer opening fence is not closed by a shorter inner one', () => {
    const src = ['````md', '```', 'class EnhancedParser {}', '```', '````'].join('\n');
    assert.ok(!fires('naming-inflated', src, CODE, { lang: 'md' }));
  });

  test('tilde fences work the same', () => {
    const src = ['~~~js', 'class EnhancedParser {}', '~~~'].join('\n');
    assert.ok(!fires('naming-inflated', src, CODE, { lang: 'md' }));
  });

  test('an unterminated fence blanks to end of file', () => {
    const src = ['```js', 'class EnhancedParser {}'].join('\n');
    assert.ok(!fires('naming-inflated', src, CODE, { lang: 'md' }));
  });
});

// ---------------------------------------------------------------------------
// testfile-duplicate-body
// ---------------------------------------------------------------------------

describe('testfile-duplicate-body', () => {
  const dup = [
    "it('passes the editorRole filter', () => {",
    '  const r = call({ editorRole: "CRC" });',
    '  expect(r).toBe("CRC");',
    '  expect(r).toBeTruthy();',
    '});',
    "it('passes the subjectId filter', () => {",
    '  const r = call({ editorRole: "PI" });',
    '  expect(r).toBe("PI");',
    '  expect(r).toBeTruthy();',
    '});',
  ].join('\n');

  test('fires when two bodies differ only in their literals', () => {
    assert.ok(fires('testfile-duplicate-body', dup, TEST));
  });

  test('one finding per group, naming every sibling line', () => {
    const found = scan(dup, { ruleClasses: TEST }).findings
      .filter((f) => f.ruleId === 'testfile-duplicate-body');
    assert.equal(found.length, 1, 'a 4-way group must not consume the whole warn cap');
    assert.equal(found[0].line, 1);
    assert.match(found[0].excerpt, /2 tests share this body; lines 1, 6/);
  });

  test('silent when the bodies differ structurally', () => {
    const distinct = [
      "it('adds', () => {",
      '  const r = add(1);',
      '  expect(r).toBe(1);',
      '  expect(r).toBeTruthy();',
      '});',
      "it('removes', () => {",
      '  const r = remove(1);',
      '  del(r);',
      '  expect(r).toBeNull();',
      '});',
    ].join('\n');
    assert.ok(!fires('testfile-duplicate-body', distinct, TEST));
  });

  test('silent for bodies under three lines', () => {
    const tiny = [
      "it('a', () => {", '  expect(f(1)).toBe(1);', '});',
      "it('b', () => {", '  expect(f(2)).toBe(2);', '});',
    ].join('\n');
    assert.ok(!fires('testfile-duplicate-body', tiny, TEST));
  });

  test('does not fire on a non-test file', () => {
    assert.ok(!fires('testfile-duplicate-body', dup, CODE));
  });
});

// ---------------------------------------------------------------------------
// configurable thresholds
// ---------------------------------------------------------------------------

describe('rule options', () => {
  const subject = 'x'.repeat(80);

  test('the string severity form still works', () => {
    assert.ok(!fires('commit-subject-trailing-period', 'fix the parser.', ['commit'], {
      config: { 'commit-subject-trailing-period': 'off' },
    }));
  });

  test('an 80-char subject is silent under the default max of 100', () => {
    assert.ok(!fires('commit-subject-too-long', subject, ['commit']));
  });

  test('and fires once the repo lowers max to 72', () => {
    assert.ok(fires('commit-subject-too-long', subject, ['commit'], {
      config: { 'commit-subject-too-long': { max: 72 } },
    }));
  });

  test('severity and a threshold can be set together', () => {
    const found = scan(subject, {
      ruleClasses: ['commit'],
      config: { 'commit-subject-too-long': { severity: 'warn', max: 72 } },
    }).findings.filter((f) => f.ruleId === 'commit-subject-too-long');
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'warn');
    assert.match(found[0].excerpt, /80 chars, limit 72/);
  });

  test('comment-density minComments is tunable', () => {
    const four = ['// a', '// b', '// c', '// d', 'const x = 1;'].join('\n');
    assert.ok(!fires('comment-density', four, CODE, { lang: 'ts' }));
    assert.ok(fires('comment-density', four, CODE, {
      lang: 'ts', config: { 'comment-density': { minComments: 4 } },
    }));
  });

  test('an unknown option is a loud config error', () => {
    assert.throws(
      () => validateConfig({ 'comment-density': { nope: 3 } }),
      UnknownRuleError
    );
  });

  test('an option on a rule that takes none is a loud config error', () => {
    assert.throws(
      () => validateConfig({ 'commit-filler': { max: 3 } }),
      UnknownRuleError
    );
  });

  test('a non-positive threshold is a loud config error', () => {
    assert.throws(
      () => validateConfig({ 'commit-subject-too-long': { max: 0 } }),
      UnknownRuleError
    );
  });

  test('a bad severity inside the object form is still caught', () => {
    assert.throws(
      () => validateConfig({ 'comment-density': { severity: 'loud' } }),
      UnknownRuleError
    );
  });

  test('severity is omitted, not undefined, so a merge cannot erase it', () => {
    // hook.mjs merges per key across nested .no-slop.json files; an explicit
    // `severity: undefined` would spread over and erase a parent's setting.
    const only = validateConfig({ 'commit-subject-too-long': { max: 72 } });
    assert.ok(!('severity' in only['commit-subject-too-long']));
  });
});
