'use strict';

// 语法/加载检查：加载全部源码，确保无语法错误（作为构建检查的一部分）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync } from 'node:fs';

const here = path.dirname(new URL(import.meta.url).pathname);
const srcDir = path.join(here, '..', 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js'));
let failed = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(path.join(srcDir, f)).href);
    console.log(`ok    ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${f}: ${e.message}`);
  }
}
if (failed) { console.error(`构建检查失败：${failed} 个文件`); process.exit(1); }
console.log(`构建检查通过：${files.length} 个源文件均可加载`);
