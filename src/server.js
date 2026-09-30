'use strict';

// 无第三方依赖的 HTTP 服务：
//   GET  /                 操作页面
//   GET  /healthz          健康路径
//   GET  /api/state        当前草稿与冻结证据
//   PUT  /api/drafts       替换草稿（任一次修改都会清除旧审计证据）
//   POST /api/audit        对当前草稿执行审计并冻结结论
//   POST /api/reset        清空草稿与证据
//
// 环境变量：PORT（默认 8080）、HOST（默认 0.0.0.0）

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { audit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'web', 'index.html');

function createState() {
  return {
    draft: { variables: [], rules: [] },
    frozen: null, // { at, input, result }
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

export function createServer(initialState) {
  const state = initialState || createState();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /healthz') {
        return json(res, 200, { status: 'ok', service: 'attitude-guard-audit', time: new Date().toISOString() });
      }

      if (route === 'GET /') {
        const html = await readFile(INDEX_HTML, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (route === 'GET /api/state') {
        return json(res, 200, { draft: state.draft, frozen: state.frozen });
      }

      if (route === 'PUT /api/drafts') {
        const body = await readJson(req);
        const variables = Array.isArray(body.variables) ? body.variables : [];
        const rules = Array.isArray(body.rules) ? body.rules : [];
        state.draft = {
          variables: variables.map((v) => String(v ?? '')),
          rules: rules.map((r) => ({
            id: String(r?.id ?? ''),
            action: String(r?.action ?? ''),
            condition: String(r?.condition ?? ''),
          })),
        };
        // 修改任一草稿即清除旧证据
        const cleared = state.frozen !== null;
        state.frozen = null;
        return json(res, 200, { ok: true, evidenceCleared: cleared, draft: state.draft, frozen: null });
      }

      if (route === 'POST /api/audit') {
        const result = audit(state.draft.variables, state.draft.rules);
        state.frozen = {
          at: new Date().toISOString(),
          input: JSON.parse(JSON.stringify(state.draft)),
          result,
        };
        return json(res, 200, state.frozen);
      }

      if (route === 'POST /api/reset') {
        state.draft = { variables: [], rules: [] };
        state.frozen = null;
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: `未找到路由：${route}` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`[attitude-guard-audit] http://${host}:${port}  健康路径 /healthz`);
  });
}
