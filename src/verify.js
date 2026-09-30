'use strict';

// 一次性验收服务：围绕决策表边界完成可观察结果核对，结束后必须退出，
// 退出码 0 = 全部通过，非 0 = 存在失败项。
//
// 运行方式：
//   node src/verify.js                         本地：进程内临时起 HTTP 服务
//   BASE_URL=http://app:8080 node src/verify.js  Compose：核对运行中的页面服务

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, MAX_VARS, MAX_RULES } from './audit.js';
import { createServer } from './server.js';

const IS_MAIN = !!process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

let failures = 0;
let checks = 0;
const lines = [];
function ok(cond, name, detail) {
  checks++;
  if (cond) { lines.push(`  PASS  ${name}`); }
  else { failures++; lines.push(`  FAIL  ${name}${detail ? `\n        → ${detail}` : ''}`); }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(title) { lines.push(`\n== ${title} ==`); }

function assignMap(list) {
  const m = new Map();
  for (const a of list || []) m.set(a.variable, a.value === 'true');
  return m;
}

// ---------- 一、决策表边界（直接核对符号裁决核心） ----------
function checkDecisionBoundaries() {
  section('决策表边界：safe 与 !safe（无空洞且无重叠）');
  const partition = audit(['safe'], [
    { id: 'R1', action: 'allow', condition: 'safe' },
    { id: 'R2', action: 'lockout', condition: '!safe' },
  ]);
  ok(partition.ok, '审计成功执行', JSON.stringify(partition.errors));
  const a = partition.audit;
  ok(a.passed, '裁决通过');
  eq(a.holes.exists, false, '无空洞');
  eq(a.overlaps.exists, false, '无重叠');
  eq(a.totalAssignments, '2', '全赋值空间大小为 2');
  eq(a.rules.map((r) => r.nodeSummary.satisfyingAssignments), ['1', '1'], '两规则各覆盖 1 个赋值');
  ok(a.rules.every((r) => r.nodeSummary.canonical && r.nodeSummary.reachableNodes >= 1), '各规则含规范节点摘要');
  eq(a.variableOrder, ['safe'], '变量按 ASCII 序');

  section('决策表边界：只有 armed 条件（首个空洞 armed=false）');
  const hole = audit(['armed'], [{ id: 'R9', action: 'fire', condition: 'armed' }]);
  ok(hole.ok && !hole.audit.passed, '裁决不通过');
  eq(hole.audit.holes.exists, true, '存在空洞');
  const h0 = assignMap(hole.audit.holes.firstAssignment);
  eq(h0.get('armed'), false, '首个空洞为 armed=false');
  eq(hole.audit.holes.satisfyingAssignments, '1', '空洞赋值数为 1');

  section('决策表边界：不同动作相交（首个赋值 + 按标识排序的命中规则）');
  const overlap = audit(['safe', 'armed'], [
    { id: 'R2', action: 'lockout', condition: '!safe' },
    { id: 'R1', action: 'hold', condition: 'safe | armed' },
  ]);
  ok(overlap.ok && !overlap.audit.passed, '裁决不通过');
  eq(overlap.audit.overlaps.exists, true, '存在重叠');
  eq(overlap.audit.overlaps.oppositeActions, true, '属于不同动作同时触发');
  const oa = assignMap(overlap.audit.overlaps.firstAssignment);
  eq([oa.get('armed'), oa.get('safe')], [true, false], '首个重叠赋值 armed=true, safe=false');
  eq(overlap.audit.overlaps.hits.map((h) => h.id), ['R1', 'R2'], '命中规则按标识 ASCII 排序');
  eq(overlap.audit.overlaps.hits.map((h) => h.action), ['hold', 'lockout'], '命中规则附带动作名');

  section('变量顺序：按标识 ASCII 序（大写优先于小写，逐码点比较）');
  const order = audit(['z', 'A', 'b', 'B', 'a'], [
    { id: 'r1', action: 'x', condition: 'z & A & b & B & a' },
    { id: 'r2', action: 'y', condition: '!(z & A & b & B & a)' },
  ]);
  eq(order.audit.variableOrder, ['A', 'B', 'a', 'b', 'z'], 'ASCII 序：A<B<a<b<z');
  ok(order.audit.passed, '互补规则仍然完备互斥');

  section('输入错误：一次定位非法标识 / 未知变量 / 空条件 / 残缺语法等');
  const bad = audit(['ok', '2bad'], [
    { id: 'R1', action: 'go', condition: 'ok & missing' },        // 未知变量
    { id: '', action: 'go', condition: '' },                       // 空标识 + 空条件
    { id: 'R3', action: '', condition: '!!' },                     // 空动作 + 残缺语法
    { id: 'R4', action: 'go', condition: '(ok |' },                // 残缺括号
    { id: 'R5', action: 'go', condition: 'ok &$ missing' },        // 非法字符
    { id: 'R1', action: 'go', condition: 'ok' },                   // 重复规则标识
  ]);
  ok(!bad.ok, '非法输入被拒绝');
  const all = bad.errors.map((e) => `${e.scope}: ${e.message}`).join('\n');
  ok(bad.errors.some((e) => /非法变量标识/.test(e.message) && e.scope.includes('variables[1]')), '定位非法变量标识 2bad');
  ok(bad.errors.some((e) => /未知变量/.test(e.message) && e.message.includes('missing')), '定位未知变量 missing');
  ok(bad.errors.some((e) => e.scope === 'rules[1].id' && /标识为空/.test(e.message)), '定位空规则标识');
  ok(bad.errors.some((e) => e.scope === 'rules[1].condition' && /条件为空/.test(e.message)), '定位空条件');
  ok(bad.errors.some((e) => e.scope === 'rules[2].condition' && /残缺语法/.test(e.message)), '定位残缺语法 !!');
  ok(bad.errors.some((e) => e.scope === 'rules[3].condition' && /残缺语法|缺少右括号/.test(e.message)), '定位残缺括号 (ok |');
  ok(bad.errors.some((e) => /非法字符/.test(e.message) && e.message.includes('$')), '定位非法字符 $');
  ok(bad.errors.some((e) => /规则标识重复/.test(e.message)), '定位重复规则标识 R1');
  ok(bad.errors.some((e) => e.scope === 'rules[2].action' && /动作名为空/.test(e.message)), '定位空动作名');
  ok(bad.errors.length >= 9, `一次给出全部问题（共 ${bad.errors.length} 条）`, all);

  section('容量边界：64 变量 / 96 规则（符号裁决，不枚举 2^64）');
  const vars64 = Array.from({ length: 64 }, (_, i) => `v${String(i).padStart(2, '0')}`);
  // 第一条：全部变量皆真；第二条：其补。构成完备互斥划分。
  const allTrue = vars64.join(' & ');
  const cap = audit(vars64, [
    { id: 'P1', action: 'all_set', condition: allTrue },
    { id: 'P2', action: 'rest', condition: `!(${allTrue})` },
  ]);
  ok(cap.ok, '64 变量审计可执行', JSON.stringify(cap.errors));
  ok(cap.audit.passed, '64 变量下无空洞无重叠');
  eq(cap.audit.totalAssignments, (1n << 64n).toString(), '全赋值空间为 2^64');
  eq(cap.audit.rules[0].nodeSummary.satisfyingAssignments, '1', '全真规则仅 1 个赋值满足');
  eq(cap.audit.rules[1].nodeSummary.satisfyingAssignments, ((1n << 64n) - 1n).toString(), '补规则满足 2^64-1');

  const tooManyVars = audit(Array.from({ length: MAX_VARS + 1 }, (_, i) => `x${i}`),
    [{ id: 'r', action: 'a', condition: 'x0' }]);
  ok(!tooManyVars.ok && /64/.test(tooManyVars.errors[0].message), '第 65 个变量被拒绝');
  const tooManyRules = audit(['x'], Array.from({ length: MAX_RULES + 1 }, (_, i) => ({
    id: `r${i}`, action: 'a', condition: i === 0 ? 'x' : '!x',
  })));
  ok(!tooManyRules.ok && /96/.test(tooManyRules.errors[0].message), '第 97 条规则被拒绝');

  section('非枚举保障：空洞首个赋值按 ASCII 字典序（false 优先）');
  // 覆盖除 "a=false,b=true" 外的全部赋值： (a) | (!a & !b)
  const tricky = audit(['a', 'b'], [
    { id: 'r1', action: 'go', condition: 'a | (!a & !b)' },
  ]);
  const th = assignMap(tricky.audit.holes.firstAssignment);
  eq([th.get('a'), th.get('b')], [false, true], '首个空洞是 a=false,b=true');
  eq(tricky.audit.holes.satisfyingAssignments, '1', '空洞恰有 1 个赋值');
}

// ---------- 二、HTTP / API 可观察核对 ----------
async function checkHttp(baseUrl, stopServer) {
  section('HTTP 冒烟：健康路径与页面');
  const health = await fetch(`${baseUrl}/healthz`);
  eq(health.status, 200, 'GET /healthz → 200');
  const healthBody = await health.json();
  eq(healthBody.status, 'ok', '健康体 status=ok');

  const home = await fetch(`${baseUrl}/`);
  eq(home.status, 200, 'GET / → 200');
  const html = await home.text();
  ok(html.includes('决策表审计'), '页面为可操作审计页（含标题）');

  section('API：草稿修改即清除旧证据，提交后冻结');
  const draftBody = {
    variables: ['safe'],
    rules: [
      { id: 'R1', action: 'allow', condition: 'safe' },
      { id: 'R2', action: 'lockout', condition: '!safe' },
    ],
  };
  const put1 = await (await fetch(`${baseUrl}/api/drafts`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftBody),
  })).json();
  eq(put1.ok, true, 'PUT /api/drafts 接受草稿');

  const frozen1 = await (await fetch(`${baseUrl}/api/audit`, { method: 'POST' })).json();
  ok(frozen1.result.ok && frozen1.result.audit.passed, 'POST /api/audit 冻结通过结论');
  const frozenAt = frozen1.at;
  ok(!!frozenAt, '冻结结论带时间戳');

  const state1 = await (await fetch(`${baseUrl}/api/state`)).json();
  ok(!!state1.frozen, 'GET /api/state 可见冻结证据');

  // 修改任一草稿 → 旧证据清除
  draftBody.rules[0].condition = 'safe ';
  const put2 = await (await fetch(`${baseUrl}/api/drafts`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftBody),
  })).json();
  eq(put2.evidenceCleared, true, '修改草稿返回 evidenceCleared=true');
  const state2 = await (await fetch(`${baseUrl}/api/state`)).json();
  eq(state2.frozen, null, '旧冻结证据已被清除');

  // 非法输入通过 API 冻结为“审计未执行”证据
  await fetch(`${baseUrl}/api/drafts`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variables: [], rules: [{ id: 'r', action: 'a', condition: '???' }] }),
  });
  const frozenBad = await (await fetch(`${baseUrl}/api/audit`, { method: 'POST' })).json();
  ok(!frozenBad.result.ok && frozenBad.result.errors.length > 0, '非法输入经 API 返回定位错误');

  const nf = await fetch(`${baseUrl}/no-such-path`);
  eq(nf.status, 404, '未知路由 → 404');

  if (stopServer) await stopServer();
}

// ---------- 主流程 ----------
async function main() {
  lines.push('姿态保护控制器 · 决策表审计 —— 一次性验收（verify）');
  checkDecisionBoundaries();

  const baseUrl = process.env.BASE_URL;
  let stopServer = null;
  let url = baseUrl;
  if (!baseUrl) {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    url = `http://127.0.0.1:${port}`;
    lines.push(`\n(本地模式：进程内临时服务 ${url})`);
    stopServer = () => new Promise((resolve) => server.close(resolve));
  } else {
    lines.push(`\n(远端模式：核对 ${baseUrl})`);
  }

  let httpOk = true;
  try {
    await checkHttp(url, stopServer);
  } catch (e) {
    httpOk = false;
    failures++;
    checks++;
    lines.push(`  FAIL  HTTP 核对异常：${e.stack || e.message}`);
  }

  lines.push(`\n----------------------------------------`);
  lines.push(`核对项 ${checks}，失败 ${failures}`);
  lines.push(failures === 0 ? '验收结论：PASS ✅' : '验收结论：FAIL ❌');
  console.log(lines.join('\n'));
  if (!httpOk && !baseUrl) process.exitCode = 1;
  if (failures > 0) process.exitCode = 1;
}

if (IS_MAIN) {
  main().catch((e) => {
    console.error('verify 运行异常：', e);
    process.exit(2);
  });
}
