'use strict';

// 词法 + 语法分析：条件由 标识符、! (非)、& 与 |、( ) 组成。
// 允许的写法：& / &&、| / ||，允许空白；标识符为字母/下划线开头，后接字母数字下划线。
// 所有错误一次性收集；空条件与残缺语法在此精确定位。

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

function lex(source) {
  const tokens = [];
  let i = 0;
  const push = (type, pos, end, value) => tokens.push({ type, pos, end, value });
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '(') { push('(', i, i + 1); i++; continue; }
    if (ch === ')') { push(')', i, i + 1); i++; continue; }
    if (ch === '!') { push('!', i, i + 1); i++; continue; }
    if (ch === '&') {
      if (source[i + 1] === '&') { push('&', i, i + 2); i += 2; }
      else { push('&', i, i + 1); i++; }
      continue;
    }
    if (ch === '|') {
      if (source[i + 1] === '|') { push('|', i, i + 2); i += 2; }
      else { push('|', i, i + 1); i++; }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(source);
      push('id', i, i + m[0].length, m[0]);
      i = IDENT_RE.lastIndex;
      continue;
    }
    // 非法字符
    push('ILLEGAL', i, i + 1, ch);
    i++;
  }
  return tokens;
}

function describePos(pos) { return `偏移 ${pos}`; }

function snippet(source, pos, end = pos + 1) {
  const from = Math.max(0, pos - 8);
  const before = source.slice(from, pos);
  const at = source.slice(pos, end);
  const after = source.slice(end, end + 8);
  return `${before}»${at}«${after}`.replace(/\n/g, '\\n');
}

// 语法（一元 ! 优先级最高，然后 &，然后 |）：
//   expr   := term ('|' term)*
//   term   := factor ('&' factor)*
//   factor := '!' factor | '(' expr ')' | id
class Parser {
  constructor(tokens, source, errors) {
    this.tokens = tokens;
    this.source = source;
    this.errors = errors;
    this.i = 0;
  }
  peek() { return this.tokens[this.i] || null; }
  next() { return this.tokens[this.i++]; }

  parse() {
    if (this.tokens.some((t) => t.type === 'ILLEGAL')) {
      for (const t of this.tokens) {
        if (t.type === 'ILLEGAL') {
          this.errors.push(
            `非法字符 ${JSON.stringify(t.value)}（${describePos(t.pos)}）：…${snippet(this.source, t.pos)}…`);
        }
      }
      return null;
    }
    if (this.tokens.length === 0) {
      this.errors.push('条件为空：每条规则必须提供非空布尔表达式');
      return null;
    }
    const node = this.parseExpr();
    if (this.errors.length === 0 && this.peek()) {
      const t = this.next();
      const shown = t.type === ')' ? '“)”' : JSON.stringify(t.value ?? t.type);
      this.errors.push(
        `残缺语法：意外的记号 ${shown}（${describePos(t.pos)}）：…${snippet(this.source, t.pos, t.end)}…`);
    }
    return this.errors.length ? null : node;
  }

  parseExpr() {
    let left = this.parseTerm();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== '|') break;
      this.next();
      const right = this.parseTerm();
      if (right === null) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  parseTerm() {
    let left = this.parseFactor();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== '&') break;
      this.next();
      const right = this.parseFactor();
      if (right === null) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  parseFactor() {
    const t = this.peek();
    if (!t) {
      this.errors.push('残缺语法：表达式在需要操作数的位置结束（可能缺少右操作数或多余的运算符）');
      return null;
    }
    if (t.type === '!') {
      this.next();
      const operand = this.parseFactor();
      if (operand === null) return null;
      return { kind: 'not', operand };
    }
    if (t.type === '(') {
      const open = this.next();
      if (this.peek() && this.peek().type === ')') {
        const c = this.next();
        this.errors.push(`残缺语法：${describePos(open.pos)} 的括号内为空：…${snippet(this.source, open.pos, c.end)}…`);
        return null;
      }
      const inner = this.parseExpr();
      if (inner === null) return null;
      const close = this.peek();
      if (!close || close.type !== ')') {
        const at = this.peek();
        const pos = at ? at.pos : this.source.length;
        this.errors.push(`残缺语法：缺少右括号 “)”（自 ${describePos(open.pos)} 起未闭合）：…${snippet(this.source, pos, pos)}…`);
        return null;
      }
      this.next();
      return inner;
    }
    if (t.type === ')') {
      this.next();
      this.errors.push(`残缺语法：意外的 “)”（${describePos(t.pos)}）：…${snippet(this.source, t.pos, t.end)}…`);
      return null;
    }
    if (t.type === '&' || t.type === '|') {
      this.next();
      this.errors.push(`残缺语法：运算符 ${JSON.stringify(t.value ?? t.type)} 前缺少操作数（${describePos(t.pos)}）：…${snippet(this.source, t.pos, t.end)}…`);
      return null;
    }
    this.next(); // id
    return { kind: 'var', name: t.value, pos: t.pos, end: t.end };
  }
}

// 将条件解析为 AST。错误消息数组（可能多条）；成功时 errors 为空、ast 非空。
function parseCondition(source) {
  const src = String(source ?? '');
  const errors = [];
  const tokens = lex(src);
  const parser = new Parser(tokens, src, errors);
  const ast = parser.parse();
  return { ast, errors, source: src };
}

export { parseCondition, lex };
