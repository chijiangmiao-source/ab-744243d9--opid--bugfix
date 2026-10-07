// 页面构建：将 public/ 产物同步到 dist/，并对前后端脚本做语法检查。
// 本项目前端零依赖、无需打包器；构建保证 dist/ 是干净可部署的页面产物。

import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

async function syntaxCheck(file) {
  // node --check 仅做语法解析（浏览器全局的 fetch/document 不影响解析）
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

async function main() {
  if (existsSync(dist)) await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'public'), dist, { recursive: true });

  for (const f of ['app.js']) {
    await syntaxCheck(path.join(dist, f));
  }
  for (const f of ['engine.mjs', 'drill.mjs', 'server.mjs']) {
    await syntaxCheck(path.join(root, 'src', f));
  }

  // 产物清单与构建时间，供 verify 与排障使用
  const manifest = {
    builtAt: new Date().toISOString(),
    files: ['index.html', 'app.js', 'app.css'],
  };
  await writeFile(path.join(dist, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

  const index = await readFile(path.join(dist, 'index.html'), 'utf8');
  for (const asset of ['/app.js', '/app.css']) {
    if (!index.includes(asset)) throw new Error(`index.html 缺少资源引用：${asset}`);
  }
  console.log('[build] 页面已构建至 dist/：', manifest.files.join(', '));
}

main().catch((err) => {
  console.error('[build] 失败：', err.message);
  process.exit(1);
});
