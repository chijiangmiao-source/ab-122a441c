'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BDD, ONE, ZERO } from '../src/bdd.js';
import { audit } from '../src/audit.js';
import { parseCondition } from '../src/parser.js';

// 在小规模空间上用全枚举交叉验证 ROBDD 结果（枚举仅用于*测试预言*，产品裁决不枚举）。
function truthTableCheck(t, varNames, astBuild, fn) {
  const bdd = new BDD(varNames);
  const h = astBuild(bdd);
  const n = varNames.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const m = new Map();
    varNames.forEach((v, i) => m.set(v, Boolean((mask >> i) & 1)));
    assert.equal(bdd.evaluate(h, m), fn(m), `mask=${mask}`);
  }
  return bdd;
}

test('BDD 常量与变量', () => {
  const bdd = new BDD(['a']);
  assert.equal(bdd.evaluate(ONE, new Map()), true);
  assert.equal(bdd.evaluate(ZERO, new Map()), false);
  const a = bdd.variable('a');
  assert.equal(bdd.evaluate(a, new Map([['a', true]])), true);
  assert.equal(bdd.evaluate(a, new Map([['a', false]])), false);
  assert.equal(bdd.modelCount(a).toString(), '1');
});

test('BDD 非/与/或真值表（3 变量全枚举对照）', () => {
  const vars = ['a', 'b', 'c'];
  const { ast } = parseCondition('(a & !b) | c');
  truthTableCheck(
    { assert }, vars,
    (bdd) => bdd.build(ast),
    (m) => (m.get('a') && !m.get('b')) || m.get('c'));
});

test('BDD 互补：a | !a = 1，a & !a = 0', () => {
  const bdd = new BDD(['a']);
  const a = bdd.variable('a');
  assert.equal(bdd.or(a, bdd.not(a)), ONE);
  assert.equal(bdd.and(a, bdd.not(a)), ZERO);
});

test('BDD 模型计数（缺席变量按自由变量计入）', () => {
  const bdd = new BDD(['a', 'b', 'c']);
  const a = bdd.variable('a');
  assert.equal(bdd.modelCount(a).toString(), '4');   // a=true：b,c 任意
  assert.equal(bdd.modelCount(bdd.not(a)).toString(), '4');
  const b = bdd.variable('b');
  assert.equal(bdd.modelCount(bdd.and(a, b)).toString(), '2');
  assert.equal(bdd.modelCount(bdd.or(a, b)).toString(), '6');
  assert.equal(bdd.modelCount(bdd.xor(a, b)).toString(), '4');
});

test('BDD 首个可满足赋值按 ASCII 字典序（false 优先）', () => {
  const bdd = new BDD(['a', 'b']);
  const h = bdd.build(parseCondition('!a & b').ast);
  const { found, assignment } = bdd.firstAssignment(h, ONE);
  assert.equal(found, true);
  assert.deepEqual([...assignment.values()], [false, true]);
  assert.equal(bdd.firstAssignment(ZERO, ONE).found, false);
});

test('BDD 深层顺序：变量缺席时仍取 false', () => {
  const bdd = new BDD(['a', 'b']);
  const h = bdd.variable('b');
  const { assignment } = bdd.firstAssignment(h, ONE);
  assert.equal(assignment.get('a'), false);
  assert.equal(assignment.get('b'), true);
});

test('解析：一次性收集多处错误', () => {
  assert.deepEqual(parseCondition('').errors.length >= 1, true);
  assert.ok(parseCondition('a &').errors.some((m) => /残缺语法/.test(m)));
  assert.ok(parseCondition('(a').errors.some((m) => /缺少右括号/.test(m)));
  assert.ok(parseCondition('a $ b').errors.some((m) => /非法字符/.test(m)));
  assert.ok(parseCondition('!').errors.some((m) => /残缺语法/.test(m)));
  assert.ok(parseCondition('a)').errors.some((m) => /意外的记号 “\)”/.test(m)));
  assert.equal(parseCondition('!!a').ast.kind, 'not');
});

test('审计：safe / !safe 完备互斥', () => {
  const r = audit(['safe'], [
    { id: 'R1', action: 'allow', condition: 'safe' },
    { id: 'R2', action: 'lockout', condition: '!safe' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.audit.passed, true);
  assert.equal(r.audit.holes.exists, false);
  assert.equal(r.audit.overlaps.exists, false);
});

test('审计：仅 armed 时首个空洞 armed=false', () => {
  const r = audit(['armed'], [{ id: 'R1', action: 'fire', condition: 'armed' }]);
  assert.equal(r.audit.holes.exists, true);
  assert.equal(r.audit.holes.firstAssignment[0].variable, 'armed');
  assert.equal(r.audit.holes.firstAssignment[0].value, 'false');
});

test('审计：跨动作重叠给出首个赋值与按标识排序的命中规则', () => {
  const r = audit(['safe', 'armed'], [
    { id: 'R2', action: 'lockout', condition: '!safe' },
    { id: 'R1', action: 'hold', condition: 'safe | armed' },
  ]);
  assert.equal(r.audit.overlaps.exists, true);
  assert.equal(r.audit.overlaps.oppositeActions, true);
  assert.deepEqual(
    r.audit.overlaps.firstAssignment.map((x) => [x.variable, x.value]),
    [['armed', 'true'], ['safe', 'false']]);
  assert.deepEqual(r.audit.overlaps.hits.map((h) => h.id), ['R1', 'R2']);
});

test('审计：同动作重叠同样报告（互斥性针对规则）', () => {
  const r = audit(['x'], [
    { id: 'A', action: 'go', condition: 'x' },
    { id: 'B', action: 'go', condition: 'x | !x' },
  ]);
  assert.equal(r.audit.overlaps.exists, true);
  assert.equal(r.audit.overlaps.oppositeActions, false);
});

test('审计：ASCII 变量序（大写先于小写）', () => {
  const r = audit(['z', 'A', 'a'], [
    { id: 'r1', action: 'x', condition: 'z & A & a' },
    { id: 'r2', action: 'y', condition: '!(z & A & a)' },
  ]);
  assert.deepEqual(r.audit.variableOrder, ['A', 'a', 'z']);
  assert.equal(r.audit.passed, true);
});

test('审计：未知变量/非法标识一次定位', () => {
  const r = audit(['1bad'], [{ id: '', action: 'a', condition: 'ghost' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /非法变量标识/.test(e.message)));
  assert.ok(r.errors.some((e) => /未知变量/.test(e.message)));
  assert.ok(r.errors.some((e) => /标识为空/.test(e.message)));
});

test('审计：64 变量符号裁决不枚举且结论正确', () => {
  const vars = Array.from({ length: 64 }, (_, i) => `v${String(i).padStart(2, '0')}`);
  const allTrue = vars.join(' & ');
  const r = audit(vars, [
    { id: 'P1', action: 'a', condition: allTrue },
    { id: 'P2', action: 'b', condition: `!(${allTrue})` },
  ]);
  assert.equal(r.audit.passed, true);
  assert.equal(r.audit.totalAssignments, '18446744073709551616');
});
