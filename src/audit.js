'use strict';

// 审计编排：
//  1. 一次性收集全部输入错误（数量上限、重复/非法标识、未知变量、空条件、残缺语法）；
//  2. 变量按标识 ASCII 序（码点逐字符）排序，建立 ROBDD；
//  3. 符号裁决：空洞 = 非(规则析取)；重叠 = 至少两条规则同时命中；
//  4. 首个反例沿 BDD 按 ASCII 变量序下降取得（非枚举）；
//  5. 输出每条规则的规范节点摘要与覆盖结论。

import { parseCondition } from './parser.js';
import { BDD, ZERO, ONE } from './bdd.js';

export const MAX_VARS = 64;
export const MAX_RULES = 96;

// 与词法器标识符定义保持一致
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ASCII 顺序：按字符码点逐字符比较（大写字母排在小写之前）
function asciiCompare(a, b) {
  const la = a.length, lb = b.length;
  const n = Math.min(la, lb);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return la - lb;
}

function collectAstVars(ast, out) {
  if (!ast) return;
  if (ast.kind === 'var') { out.add(ast.name); return; }
  if (ast.kind === 'not') { collectAstVars(ast.operand, out); return; }
  collectAstVars(ast.left, out);
  collectAstVars(ast.right, out);
}

// rules: [{ id, action, condition }]
// variables: [ 标识符, ... ]
// 返回 { ok, errors:[{scope,message}], audit:null | 结论对象 }
function audit(variablesInput, rulesInput) {
  const errors = [];
  const add = (scope, message) => errors.push({ scope, message });

  const rawVars = Array.isArray(variablesInput)
    ? variablesInput.map((v) => (v === null || v === undefined ? '' : String(v)).trim())
    : [];
  const rawRules = Array.isArray(rulesInput) ? rulesInput : [];

  // ---- 数量上限（超限也继续检查能检查的内容） ----
  if (rawVars.length > MAX_VARS) {
    add('variables', `稳定变量数量 ${rawVars.length} 超过上限 ${MAX_VARS}`);
  }
  if (rawRules.length > MAX_RULES) {
    add('rules', `规则数量 ${rawRules.length} 超过上限 ${MAX_RULES}`);
  }
  if (rawRules.length === 0) {
    add('rules', '至少需要一条规则');
  }

  // ---- 变量标识校验（一次定位全部） ----
  const varSet = new Set();
  rawVars.forEach((name, i) => {
    if (name === '') { add(`variables[${i}]`, '变量标识为空'); return; }
    if (!IDENT_RE.test(name)) {
      add(`variables[${i}]`, `非法变量标识 ${JSON.stringify(name)}：须为字母/下划线开头，仅含字母数字下划线`);
      return;
    }
    if (varSet.has(name)) { add(`variables[${i}]`, `变量标识重复：${JSON.stringify(name)}`); return; }
    varSet.add(name);
  });

  // ---- 规则校验 ----
  const parsed = [];
  const ruleIdSeen = new Set();
  rawRules.forEach((rule, ri) => {
    const scope = (k) => `rules[${ri}]${k ? '.' + k : ''}`;
    const id = rule && rule.id !== undefined && rule.id !== null ? String(rule.id).trim() : '';
    const action = rule && rule.action !== undefined && rule.action !== null ? String(rule.action).trim() : '';
    const condSource = rule && rule.condition !== undefined && rule.condition !== null
      ? String(rule.condition) : '';

    if (id === '') { add(scope('id'), '规则唯一标识为空'); }
    else if (ruleIdSeen.has(id)) { add(scope('id'), `规则标识重复：${JSON.stringify(id)}`); }
    else ruleIdSeen.add(id);

    if (action === '') { add(scope('action'), '动作名为空'); }
    if (!IDENT_RE.test(action)) {
      add(scope('action'), `非法动作名 ${JSON.stringify(action)}：须为字母/下划线开头，仅含字母数字下划线`);
    }

    const { ast, errors: syntaxErrors } = parseCondition(condSource);
    for (const msg of syntaxErrors) add(scope('condition'), msg);

    if (ast) {
      const used = new Set();
      collectAstVars(ast, used);
      for (const name of used) {
        if (!varSet.has(name)) add(scope('condition'), `未知变量：${JSON.stringify(name)} 未在稳定变量清单中声明`);
      }
    }
    parsed.push({ id: id || `#${ri + 1}`, action: action || '(empty)', condition: condSource, ast, index: ri });
  });

  if (errors.length) return { ok: false, errors, audit: null };

  // ---- 建图：变量严格按 ASCII 序 ----
  const orderedVars = [...varSet].sort(asciiCompare);
  const bdd = new BDD(orderedVars);
  const handles = parsed.map((p) => bdd.build(p.ast));

  // ---- 覆盖与重叠（符号运算） ----
  let union = ZERO;
  for (const h of handles) union = bdd.or(union, h);
  const hole = bdd.not(union);

  // 两两重叠：收集“不同规则对”的交。同动作重叠也属于决策表缺陷吗？
  // 需求关注“相反动作同时触发”，但任意多命中都让“恰好命中一条动作”不成立，
  // 因此重叠判定对所有规则对生效，并标注动作是否相同。
  const pairs = [];
  let anyOverlap = ZERO;
  for (let i = 0; i < handles.length; i++) {
    for (let j = i + 1; j < handles.length; j++) {
      const inter = bdd.and(handles[i], handles[j]);
      if (inter !== ZERO) {
        pairs.push({ i, j, inter });
        anyOverlap = bdd.or(anyOverlap, inter);
      }
    }
  }

  const fmtAssignment = (assignment) => orderedVars.map((v) => ({
    variable: v, value: assignment.get(v) ? 'true' : 'false',
  }));

  const totalModels = 1n << BigInt(orderedVars.length);

  // ---- 空洞结论 ----
  const holeFirst = bdd.firstAssignment(hole, ONE);
  const holeReport = {
    exists: holeFirst.found,
    firstAssignment: holeFirst.found ? fmtAssignment(holeFirst.assignment) : null,
    satisfyingAssignments: bdd.modelCount(hole).toString(),
  };

  // ---- 重叠结论 ----
  let overlapReport;
  if (!pairs.length) {
    overlapReport = { exists: false, firstAssignment: null, hits: [], oppositeActions: false };
  } else {
    const first = bdd.firstAssignment(anyOverlap, ONE);
    // 首个重叠赋值处命中的全部规则（按规则标识 ASCII 排序输出）
    const hits = parsed
      .map((p, idx) => ({ rule: p, hit: bdd.evaluate(handles[idx], first.assignment) }))
      .filter((x) => x.hit)
      .map((x) => ({ id: x.rule.id, action: x.rule.action, index: x.rule.index }))
      .sort((a, b) => asciiCompare(a.id, b.id));
    const distinctActions = new Set(hits.map((h) => h.action));
    overlapReport = {
      exists: true,
      firstAssignment: fmtAssignment(first.assignment),
      hits,
      oppositeActions: distinctActions.size > 1,
      hitPairCount: pairs.length,
    };
  }

  const passed = !holeReport.exists && !overlapReport.exists;

  const rules = parsed.map((p, idx) => ({
    id: p.id,
    action: p.action,
    condition: p.condition,
    nodeSummary: {
      canonical: bdd.canonicalSummary(handles[idx]),
      reachableNodes: bdd.nodeCount(handles[idx]),
      satisfyingAssignments: bdd.modelCount(handles[idx]).toString(),
    },
  }));

  return {
    ok: true,
    errors: [],
    audit: {
      passed,
      method: 'ROBDD 符号裁决（变量顺序=标识 ASCII 序；未枚举、抽样或穷举赋值）',
      variableCount: orderedVars.length,
      variableOrder: orderedVars,
      ruleCount: parsed.length,
      totalAssignments: totalModels.toString(),
      holes: holeReport,
      overlaps: overlapReport,
      conclusion: passed
        ? '无空洞且无重叠：全赋值空间每条赋值恰好命中一条规则，可冻结审计结论。'
        : [
            holeReport.exists ? '存在空洞（未覆盖赋值，将进入未定义状态）' : null,
            overlapReport.exists
              ? (overlapReport.oppositeActions ? '存在不同动作规则同时触发的重叠' : '存在多条规则同时触发的重叠')
              : null,
          ].filter(Boolean).join('；') + '：禁止冻结，请修改后重新审计。',
      rules,
    },
  };
}

export { audit, asciiCompare };
