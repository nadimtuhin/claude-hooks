// Regenerates parity/fixtures. Run from hooks/no-slop: node parity/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'fixtures');
const cases = fs
  .readFileSync(path.join(here, '../go/testdata/scan_cases.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

fs.rmSync(out, { recursive: true, force: true });
const put = (rel, content) => {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));
const texts = (list) => list.map((c) => c.text).join('\n');

const byLang = new Map();
for (const c of cases) {
  const key = c.lang || '';
  byLang.set(key, [...(byLang.get(key) ?? []), c]);
}
const plain = byLang.get('') ?? [];
chunks(plain, 40).forEach((chunk, i) => put(`recorded/plain-${i}.ts`, texts(chunk)));
chunks(plain, 80).slice(0, 2).forEach((chunk, i) => {
  for (const ext of ['py', 'go', 'sh', 'rb', 'rs', 'md', 'java', 'sql']) put(`recorded/lang-${i}.${ext}`, texts(chunk));
});
chunks(plain, 60).slice(0, 2).forEach((chunk, i) => put(`tests/recorded-${i}.spec.ts`, texts(chunk)));
for (const [lang, list] of byLang) if (lang) put(`recorded/own-${lang}.${lang}`, texts(list));

const slop = [
  '// as you requested',
  '// set the value',
  'const userObject = {};',
  'const dataHelper = 1;',
  "// we now use the new parser instead of the old one",
  'function getUserInfoData() { return 1; }',
].join('\n');

const boundary = [];
for (let k = 80; k <= 112; k++) boundary.push(`// as you requested ${'x'.repeat(k)}😀 tail`);
put('edge/emoji.ts', ['// 🎉 Add the new parser 🚀 as you requested', 'export const userObject = { a: "😀😀😀" };', ...boundary, slop].join('\n'));
put('edge/bengali.py', ['# এটি একটি ধারণা, as you requested', 'ব্যবহারকারী_তথ্য = 1  # per your review feedback', '# set the value', 'def get_user_info_data(): pass', slop].join('\n'));
put('edge/crlf.ts', `${slop.split('\n').join('\r\n')}\r\n// per your review feedback\r\nconst x = a ? b : c ? d : e;\r\n`);
put('edge/lf-only-cr.ts', `${slop.split('\n').join('\r')}\r`);
put('edge/longline.js', [`// ${'word '.repeat(500)}`, `// as you requested ${'y'.repeat(300)}`, `const a = "${'z'.repeat(2100)}"; // as you requested`, slop].join('\n'));
put('edge/nested-ternary.ts', [
  'const a = x ? y : z;',
  'const b = x ? y : p ? q : r;',
  'const c = x ? (y ? 1 : 2) : 3;',
  'const d = cond ? "a?b:c" : other ? 1 : 2;',
  'const e = (x ?? y) ? 1 : 2;',
  'const f = obj?.a ? obj.b : obj.c ? 1 : 2;',
].join('\n'));
put('edge/disable-directives.ts', [
  '// no-slop-disable-next-line comment-provenance',
  '// as you requested',
  '// as you requested',
  '/* no-slop-disable naming-redundant-type-suffix */',
  'const userObject = {};',
  '/* no-slop-enable naming-redundant-type-suffix */',
  'const dataObject = {};',
  '// no-slop-disable-next-line *',
  '// per your review feedback',
  '// no-slop-disable *',
  '// per your review feedback',
  '// set the value',
  '// no-slop-enable',
  '// per your review feedback',
  '// no-slop-disable comment-provenance',
  '// as you requested',
].join('\n'));
put('edge/pragmas.ts', [
  '// as you requested // slop-ok',
  'const userObject = {}; // slop-ok: naming-redundant-type-suffix',
  'const dataObject = {}; // slop-ok: comment-provenance, naming-redundant-type-suffix',
  '// slop-ok',
  '// as you requested',
  '// as you requested // slop-ok: comment-provenance',
  'const resultObject = {}; // slop-ok:',
].join('\n'));
put('edge/pragmas.py', ['# as you requested  # slop-ok', 'user_object = {}  # slop-ok: naming-redundant-type-suffix', '# per your review feedback'].join('\n'));
put('edge/bom.ts', `﻿${slop}\n`);
put('edge/unicode-ws.md', `# Title with separator\n\nNot just this, it's　more. \n\n${slop}\n  // as you requested\n`);
put('edge/empty.ts', '');
put('edge/blank.py', '\n\n   \n');
put('edge/no-final-newline.sh', '# as you requested\necho hi');
fs.writeFileSync(path.join(out, 'edge/invalid-utf8.ts'), Buffer.concat([
  Buffer.from('// as you requested é caf'),
  Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82, 0xf0, 0x9f, 0x98, 0xed, 0xa0, 0x80, 0xc0, 0xaf]),
  Buffer.from('\nconst userObject = {};\n// per your review feedback\n'),
]));
fs.writeFileSync(path.join(out, 'edge/invalid-utf8-long.ts'), Buffer.concat([
  Buffer.from(`// as you requested ${'x'.repeat(97)}`),
  Buffer.from([0xf0, 0x9f, 0x98]),
  Buffer.from(' tail\n'),
]));

put('with-config/.no-slop.json', JSON.stringify({ rules: { 'comment-provenance': 'block', 'naming-redundant-type-suffix': 'off', 'comment-density': { minComments: 2, minCode: 2, severity: 'block' } } }, null, 2));
put('with-config/a.ts', `${slop}\n`);
put('with-config/nested/.no-slop.json', JSON.stringify({ rules: { 'comment-density': { minComments: 5 }, 'naming-inflated': 'block' } }));
put('with-config/nested/b.ts', `${slop}\n// one\n// two\n// three\n// four\n// five\nconst a = 1;\n`);
put('with-baseline/.no-slop-baseline.json', JSON.stringify({ version: 1, findings: { 'b.ts': ['1:comment-provenance', '3:naming-redundant-type-suffix'], 'sub/c.ts': ['1:comment-provenance'] } }, null, 2));
put('with-baseline/b.ts', `${slop}\n`);
put('with-baseline/sub/c.ts', `${slop}\n`);

put('with-vague/.no-slop.json', JSON.stringify({ rules: { 'naming-vague-generic': 'warn' } }, null, 2));
put('with-vague/a.ts', 'const data = loadAll();\nfunction processData(rows) {\n  return rows;\n}\nconst helper = () => 1;\nlet temp = 0;\n');

const duplicateBody = (title, literal) => `  it('${title}', () => {
    const input = build(${literal});
    const output = run(input);
    expect(output).toBe(${literal});
  });`;
put('tests/duplicate-bodies.spec.ts', `describe('runner', () => {
${duplicateBody('handles one', 1)}

${duplicateBody('handles two', 2)}
});
`);
put('tests/no-assertions.spec.ts', `describe('runner', () => {
  it('starts the worker and drains the queue', () => {
    const worker = start();
    worker.drain();
  });
});
`);
put('prose-notes.md', '# Notes\n\nSee §7 for the retry policy.\n\nSee "§ 5" quoted, which is spared.\n');
put('bare-pragma.ts', 'const userObject = {}; // slop-ok\n');

put('commits.json', JSON.stringify([
  'fix null deref in parser',
  'wip',
  'Add cutting-edge parser',
  `${'a'.repeat(101)}`,
  `${'😀'.repeat(51)}`,
  'fix: handle the empty case\n\nThis commit introduces a robust, seamless solution.\n\nCo-Authored-By: Someone <a@b.c>',
  'Updated stuff and various changes\n\nChanges made:\n- cleanup',
  'বাংলা কমিট মেসেজ\n\nবিস্তারিত',
  '',
  'x\r\n\r\ny',
  'Implements the feature as requested by the user\n\nper your review feedback',
  'fix null deref in the parser.',
  'Add retries...',
]));
put('prose.json', JSON.stringify([
  "You're absolutely right, the lock leaks.",
  "Great question! Let's delve into the tapestry of this realm of concurrency.",
  "It's not just a bug, it's a design flaw. This is not merely about speed, it's about trust.",
  'Plain sentence about the parser.\n\n```ts\n// as you requested\nconst x = 1;\n```\n\nSee § 4 for details, and "§ 5" quoted.',
  'বাংলা বাক্য। Certainly! I apologize for the confusion.',
  '😀'.repeat(80),
  'Refer to §7 for the retry policy.',
  '',
]));
console.log('fixtures written to', out);
