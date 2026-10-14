const help = "slop-ok: naming-inflated";
class EnhancedParser {}
// ==========================
// small helpers
// ==========================
const a = 1;
// ==========================
const b = 2;
// ==========================
function go() {}
it('passes the editorRole filter', () => {
  const r = call({ editorRole: "CRC" });
  expect(r).toBe("CRC");
  expect(r).toBeTruthy();
});
it('passes the subjectId filter', () => {
  const r = call({ editorRole: "PI" });
  expect(r).toBe("PI");
  expect(r).toBeTruthy();
});
it('adds', () => {
  const r = add(1);
  expect(r).toBe(1);
  expect(r).toBeTruthy();
});
it('removes', () => {
  const r = remove(1);
  del(r);
  expect(r).toBeNull();
});
it('a', () => {
  expect(f(1)).toBe(1);
});
it('b', () => {
  expect(f(2)).toBe(2);
});
it('passes the editorRole filter', () => {
  const r = call({ editorRole: "CRC" });
  expect(r).toBe("CRC");
  expect(r).toBeTruthy();
});
it('passes the subjectId filter', () => {
  const r = call({ editorRole: "PI" });
  expect(r).toBe("PI");
  expect(r).toBeTruthy();
});
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx