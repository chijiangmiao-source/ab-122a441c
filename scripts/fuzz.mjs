'use strict';
// 临时模糊测试：随机公式/随机规则集，对小规模空间用枚举交叉验证 ROBDD 裁决。
import { BDD } from '../src/bdd.js';
import { parseCondition } from '../src/parser.js';
import { audit } from '../src/audit.js';

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const rnd = rng(20260930);
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

function genExpr(vars, depth) {
  if (depth <= 0 || rnd() < 0.35) return pick(vars);
  const r = rnd();
  if (r < 0.25) return `!(${genExpr(vars, depth - 1)})`;
  if (r < 0.6) return `(${genExpr(vars, depth - 1)} & ${genExpr(vars, depth - 1)})`;
  return `(${genExpr(vars, depth - 1)} | ${genExpr(vars, depth - 1)})`;
}
function evalExpr(node, m) {
  switch (node.kind) {
    case 'var': return m[node.name];
    case 'not': return !evalExpr(node.operand, m);
    case 'and': return evalExpr(node.left, m) && evalExpr(node.right, m);
    case 'or': return evalExpr(node.left, m) || evalExpr(node.right, m);
  }
}

// 1) 公式真值表 + 模型计数
for (let iter = 0; iter < 400; iter++) {
  const n = 1 + ri(5);
  const vars = Array.from({ length: n }, (_, i) => `v${i}`);
  const src = genExpr(vars, 3);
  const { ast } = parseCondition(src);
  if (!ast) throw new Error(`parse fail: ${src}`);
  const bdd = new BDD(vars);
  const h = bdd.build(ast);
  let trueCount = 0n;
  for (let mask = 0; mask < (1 << n); mask++) {
    const m = {};
    vars.forEach((v, i) => { m[v] = Boolean((mask >> i) & 1); });
    const expect = evalExpr(ast, m);
    const map = new Map(Object.entries(m));
    if (bdd.evaluate(h, map) !== expect) throw new Error(`truth mismatch: ${src} @ ${mask}`);
    if (expect) trueCount++;
  }
  if (bdd.modelCount(h) !== trueCount) throw new Error(`count mismatch: ${src}`);
}

// 2) 随机规则集：空洞数/重叠/首个反例 与枚举对照
for (let iter = 0; iter < 200; iter++) {
  const n = 1 + ri(4);
  const vars = Array.from({ length: n }, (_, i) => `v${i}`);
  const nr = 1 + ri(5);
  const rules = [];
  const asts = [];
  for (let r = 0; r < nr; r++) {
    rules.push({ id: `R${r}`, action: pick(['go', 'hold']), condition: genExpr(vars, 2) });
    asts.push(parseCondition(rules[r].condition).ast);
  }
  const res = audit(vars, rules);
  if (!res.ok) throw new Error('audit should be valid');
  let firstHole = null, firstOverlap = null;
  for (let code = 0; code < (1 << n); code++) {
    // 字典序：v0 为最高位（false 优先），与 BDD 沿变量序下降一致
    const m = {};
    vars.forEach((v, i) => { m[v] = Boolean((code >> (n - 1 - i)) & 1); });
    const hits = rules.filter((_, r) => evalExpr(asts[r], m));
    if (hits.length === 0 && firstHole === null) firstHole = code;
    if (hits.length >= 2 && firstOverlap === null) firstOverlap = code;
  }
  if ((firstHole !== null) !== res.audit.holes.exists) throw new Error('hole-exist mismatch');
  if ((firstOverlap !== null) !== res.audit.overlaps.exists) throw new Error('overlap-exist mismatch');
  if (firstHole !== null) {
    const got = res.audit.holes.firstAssignment;
    vars.forEach((v, i) => {
      const expect = Boolean((firstHole >> (n - 1 - i)) & 1);
      if ((got[i].value === 'true') !== expect) throw new Error('first-hole mismatch');
    });
  }
  if (firstOverlap !== null) {
    const got = res.audit.overlaps.firstAssignment;
    vars.forEach((v, i) => {
      const expect = Boolean((firstOverlap >> (n - 1 - i)) & 1);
      if ((got[i].value === 'true') !== expect) throw new Error('first-overlap mismatch');
    });
  }
  if (res.audit.passed !== (firstHole === null && firstOverlap === null)) throw new Error('verdict mismatch');
}

// 3) 随机完备互斥划分应通过
for (let iter = 0; iter < 100; iter++) {
  const n = 1 + ri(4);
  const vars = Array.from({ length: n }, (_, i) => `v${i}`);
  const f = genExpr(vars, 3);
  const r = audit(vars, [
    { id: 'A', action: 'x', condition: f },
    { id: 'B', action: 'y', condition: `!(${f})` },
  ]);
  if (!r.audit.passed) throw new Error(`partition should pass: ${f}`);
}

console.log('fuzz OK: 400 公式 + 200 随机规则集 + 100 互补划分 全部与枚举一致');
