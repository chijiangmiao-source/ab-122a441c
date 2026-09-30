'use strict';

// 精简有序二叉决策图（ROBDD），变量顺序由外部给定（变量标识 ASCII 序）。
// 边使用补（complement）属性：节点只存 low/high 两个“带补句柄”，常量仅需 0 号节点。
// 带补句柄：index = handle >> 1，complement = handle & 1。
// 句柄 1（index 0，补）= 布尔真；句柄 0（index 0，不补）= 布尔假。
//
// 该实现对 2^64 赋值空间做符号裁决：空洞/重叠通过 BDD 节点运算得到，
// 任何阶段都不枚举、抽样或穷举赋值。

const ZERO = 0;
const ONE = 1;

function hIndex(h) { return h >> 1; }
function hComp(h) { return h & 1; }
function toggle(h) { return h ^ 1; }
function make(index, comp) { return (index << 1) | comp; }

function hNot(h) { return h ^ 1; }

class BDD {
  constructor(varOrder) {
    // varOrder: 变量名数组（ASCII 顺序）；level: 变量名 -> 层级（0 最靠近根）
    this.varOrder = varOrder.slice();
    this.level = new Map();
    varOrder.forEach((name, idx) => this.level.set(name, idx));
    // nodes[0] 为唯一汇点；真实节点 index >= 1
    this.nodes = [ { var: null, level: -1, low: 0, high: 0 } ];
    this.unique = new Map();       // (level, low, high) -> index
    this.iteCache = new Map();     // (i,p,g) -> handle
    this.varHandles = new Map();   // 变量名 -> 正句柄
  }

  constant(v) { return v ? ONE : ZERO; }

  variable(name) {
    if (this.varHandles.has(name)) return this.varHandles.get(name);
    if (!this.level.has(name)) throw new Error(`BDD: 未知变量 ${name}`);
    const level = this.level.get(name);
    const h = this.mkNode(level, ZERO /*false 走 low*/, ONE /*true 走 high*/);
    this.varHandles.set(name, h);
    return h;
  }

  // 返回规范句柄。约定：存储节点的低端（low/else）必须不补；
  // 若入参低端带补，则同时翻转两条边并以“带补句柄”返回该节点。
  mkNode(level, low, high) {
    // 香农展开归约：若两条边等价（含补位），节点退化为该边本身
    if (low === high) return low;
    let comp = 0;
    let lo = low, hi = high;
    if (hComp(lo) === 1) { lo = toggle(lo); hi = toggle(hi); comp = 1; }
    const key = `${level}:${lo}:${hi}`;
    let idx = this.unique.get(key);
    if (idx === undefined) {
      idx = this.nodes.length;
      this.nodes.push({ var: this.varOrder[level], level, low: lo, high: hi });
      this.unique.set(key, idx);
    }
    return make(idx, comp);
  }

  // ITE(f, g, h)：f 为真取 g，否则取 h（f/g/h 均为带补句柄）
  ite(f, g, h) {
    // 终端情形
    if (f === ONE) return g;
    if (f === ZERO) return h;
    if (g === ONE && h === ZERO) return f;
    if (g === h) return g;
    const key = `${f},${g},${h}`;
    const cached = this.iteCache.get(key);
    if (cached !== undefined) return cached;

    const fi = hIndex(f);
    const fn = this.nodes[fi];
    const gi = hIndex(g), hi = hIndex(h);
    const gn = this.nodes[gi], hn = this.nodes[hi];
    // 常量汇点对任何变量都不分裂，其层级视为 +∞
    const levelOf = (idx, node) => (idx === 0 ? Infinity : node.level);
    const top = Math.min(levelOf(fi, fn), levelOf(gi, gn), levelOf(hi, hn));

    const cofactor = (handle, lev, isHigh) => {
      const node = this.nodes[hIndex(handle)];
      const c = hComp(handle);
      if (node.level !== lev) return handle; // 节点在该层缺席：两条余因子相同
      const edge = isHigh ? node.high : node.low;
      return c ? toggle(edge) : edge;
    };

    const t = this.ite(
      cofactor(f, top, true), cofactor(g, top, true), cofactor(h, top, true));
    const u = this.ite(
      cofactor(f, top, false), cofactor(g, top, false), cofactor(h, top, false));

    let result;
    if (t === u) {
      result = t;
    } else {
      // mkNode 接收 (low=假分支 u, high=真分支 t)，返回规范句柄
      result = this.mkNode(top, u, t);
    }
    this.iteCache.set(key, result);
    return result;
  }

  not(a) { return hNot(a); }
  and(a, b) { return this.ite(a, b, ZERO); }
  or(a, b) { return this.ite(a, ONE, b); }
  imp(a, b) { return this.ite(a, b, ONE); }
  xor(a, b) { return this.ite(a, hNot(b), b); }

  build(ast) {
    switch (ast.kind) {
      case 'var': return this.variable(ast.name);
      case 'not': return hNot(this.build(ast.operand));
      case 'and': return this.and(this.build(ast.left), this.build(ast.right));
      case 'or': return this.or(this.build(ast.left), this.build(ast.right));
      default: throw new Error(`BDD: 未知 AST 节点 ${ast.kind}`);
    }
  }

  // 求“按变量顺序、令函数为 need 的字典序首个赋值”。
  // 字典序：ASCII 顺序变量依次取 false 再 true（false=0 < true=1）。
  // 返回 { assignment: Map(变量名 -> bool), found }，全程沿 BDD 下降，复杂度 O(变量数)。
  firstAssignment(handle, need = ONE) {
    const assignment = new Map();
    let h = need === ONE ? handle : hNot(handle);
    if (h === ZERO) return { found: false, assignment };
    let idx = hIndex(h);
    let comp = hComp(h);
    for (let level = 0; level < this.varOrder.length; level++) {
      const node = idx === 0 ? null : this.nodes[idx];
      if (!node || node.level > level) {
        // 该变量缺席：函数与它无关，取 false 即可保持可行
        assignment.set(this.varOrder[level], false);
        continue;
      }
      // node.level === level
      const pick = (edgeWanted) => {
        const edge = edgeWanted ? node.high : node.low;
        let next = comp ? toggle(edge) : edge;
        idx = hIndex(next);
        comp = hComp(next);
      };
      // 优先尝试 false 分支（low）
      const lowEdge = comp ? toggle(node.low) : node.low;
      if (lowEdge !== ZERO) {
        assignment.set(this.varOrder[level], false);
        pick(false);
      } else {
        assignment.set(this.varOrder[level], true);
        pick(true);
      }
    }
    return { found: true, assignment };
  }

  // 统计函数在全部 N 个变量上的可满足赋值数（BigInt，符号 DP，不枚举）。
  // 对带补边：在子节点自己的后缀跨度内取 2^span - v，再按层间缺席变量左移。
  modelCount(handle) {
    const N = this.varOrder.length;
    const byIndex = new Map();
    const edgeCount = (edge, k) => {
      const idx = hIndex(edge);
      if (idx === 0) return hComp(edge) ? (1n << BigInt(N - k)) : 0n;
      const n = this.nodes[idx];
      const span = N - n.level; // 该节点自身后缀变量数
      let v = nodeCount(idx);
      if (hComp(edge)) v = (1n << BigInt(span)) - v;
      return v << BigInt(n.level - k);
    };
    const nodeCount = (idx) => {
      if (byIndex.has(idx)) return byIndex.get(idx);
      const n = this.nodes[idx];
      const v = edgeCount(n.low, n.level + 1) + edgeCount(n.high, n.level + 1);
      byIndex.set(idx, v);
      return v;
    };
    return edgeCount(handle, 0);
  }

  // 单点求值：assignment 为 Map(变量名 -> bool)，缺失变量不影响结果时也能判定
  evaluate(handle, assignment) {
    let h = handle;
    for (let level = 0; level < this.varOrder.length; level++) {
      const idx = hIndex(h);
      if (idx === 0) break;
      const n = this.nodes[idx];
      if (n.level > level) continue;
      const val = assignment.get(n.var) ? true : false;
      const edge = val ? n.high : n.low;
      h = hComp(h) ? toggle(edge) : edge;
    }
    return h === ONE;
  }

  // 统计可达（规范）内部节点数
  nodeCount(handle) {
    const seen = new Set();
    const walk = (hh) => {
      const idx = hIndex(hh);
      if (idx === 0 || seen.has(idx)) return;
      seen.add(idx);
      const n = this.nodes[idx];
      walk(n.low); walk(n.high);
    };
    walk(handle);
    return seen.size;
  }

  // 生成函数的前缀式规范摘要（沿唯一表下降，结构相同的函数摘要必相同）
  canonicalSummary(handle) {
    const memo = new Map();
    const go = (hh) => {
      const idx = hIndex(hh);
      const c = hComp(hh);
      if (idx === 0) return c ? '1' : '0';
      const key = hh;
      if (memo.has(key)) return memo.get(key);
      const n = this.nodes[idx];
      const inner = `ite(${n.var},${go(n.high)},${go(n.low)})`;
      const out = c ? `not(${inner})` : inner;
      memo.set(key, out);
      return out;
    };
    return go(handle);
  }
}

export { BDD, ZERO, ONE, hIndex, hComp, toggle };
