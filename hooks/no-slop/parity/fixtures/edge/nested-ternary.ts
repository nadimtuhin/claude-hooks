const a = x ? y : z;
const b = x ? y : p ? q : r;
const c = x ? (y ? 1 : 2) : 3;
const d = cond ? "a?b:c" : other ? 1 : 2;
const e = (x ?? y) ? 1 : 2;
const f = obj?.a ? obj.b : obj.c ? 1 : 2;