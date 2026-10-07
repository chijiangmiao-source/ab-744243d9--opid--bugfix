// 演练服务：零依赖（node:http），提供页面、/healthz 与演练 REST API。
// 所有演练状态原子落盘到数据文件；进程重启后恢复，可继续接收滞留投递。

import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseSheet, Drill, SheetError } from './drill.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFERRED_DIST = path.join(__dirname, '..', 'dist');
const PUBLIC_DIR = existsSync(PREFERRED_DIST)
  ? PREFERRED_DIST
  : path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'drills.json');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const store = new Map(); // id -> Drill
let writeChain = Promise.resolve();

function persist() {
  // 请求内原子落盘（临时文件 + rename）；串行化避免并发写相互覆盖。
  // 调用方 await 本承诺后再响应，确保关闭/崩溃后状态可恢复。
  // 写失败只拒绝本次调用，不把整条写链卡死。
  const snapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    drills: [...store.values()].map((d) => d.toJSON()),
  };
  const run = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await rename(tmp, DATA_FILE);
  });
  writeChain = run.catch(() => {});
  return run;
}

async function loadFromDisk() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    for (const data of raw.drills ?? []) {
      store.set(data.id, Drill.restore(data));
    }
    console.log(`[store] 已恢复 ${raw.drills?.length ?? 0} 个演练（${raw.savedAt}）`);
  } catch (err) {
    console.error('[store] 恢复失败：', err.message);
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.statusCode = 400;
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        drills: store.size,
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && /^\/(app\.js|app\.css)$/.test(pathname)) {
      const ext = path.extname(pathname);
      const file = await readFile(path.join(PUBLIC_DIR, pathname.slice(1)), 'utf8');
      res.writeHead(200, { 'Content-Type': MIME[ext] });
      res.end(file);
      return;
    }

    // ---- API ----
    const apiMatch = pathname.match(/^\/api\/drills(?:\/([^/]+))?(\/[a-z]+)?$/);
    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/drills') {
        sendJson(res, 200, {
          drills: [...store.values()].map((d) => ({
            id: d.id,
            tick: d.tick,
            length: d.length,
            finished: d.finished,
            createdAt: d.createdAt,
          })),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/drills') {
        const body = await readJson(req);
        if (typeof body.sheet !== 'string') {
          sendJson(res, 400, { error: '需要 sheet（字符串形式的 JSON 步骤单）' });
          return;
        }
        let sheet;
        try {
          sheet = parseSheet(body.sheet);
        } catch (err) {
          if (err instanceof SheetError) {
            sendJson(res, 422, { error: err.message, code: err.code });
            return;
          }
          throw err;
        }
        const id = randomUUID().slice(0, 8);
        const drill = new Drill(id, sheet, { sheetText: body.sheet });
        store.set(id, drill);
        await persist();
        sendJson(res, 201, drill.state());
        return;
      }

      if (!apiMatch) {
        sendJson(res, 404, { error: '未知接口' });
        return;
      }
      const [, id, action = ''] = apiMatch;
      const drill = store.get(id);
      if (!drill) {
        sendJson(res, 404, { error: '演练不存在或未随进程恢复' });
        return;
      }

      if (req.method === 'GET' && !action) {
        sendJson(res, 200, drill.state());
        return;
      }

      if (req.method === 'POST' && action === '/play') {
        const body = await readJson(req);
        const steps =
          body.steps === 'all' || body.steps === Infinity || body.steps === -1
            ? Infinity
            : Number(body.steps ?? 1);
        const arg = Number.isFinite(steps)
          ? Math.max(1, Math.floor(steps))
          : Infinity;
        const result = drill.play(arg);
        await persist();
        sendJson(res, 200, { ...result, state: drill.state() });
        return;
      }

      if (req.method === 'POST' && action === '/reset') {
        const state = drill.reset();
        await persist();
        sendJson(res, 200, state);
        return;
      }

      if (req.method === 'POST' && action === '/seal') {
        drill.seal();
        await persist();
        sendJson(res, 200, drill.state());
        return;
      }

      if (req.method === 'POST' && action === '/deliver') {
        const body = await readJson(req);
        if (typeof body.replica !== 'string' || !body.op || typeof body.op !== 'object') {
          sendJson(res, 400, { error: '需要 replica 与 op' });
          return;
        }
        try {
          const event = drill.deliverExtra(body.replica, body.op);
          await persist();
          sendJson(res, 200, { event, state: drill.state() });
        } catch (err) {
          if (err instanceof SheetError) {
            sendJson(res, 422, { error: err.message, code: err.code });
            return;
          }
          throw err;
        }
        return;
      }

      sendJson(res, 405, { error: '方法不允许' });
      return;
    }

    sendJson(res, 404, { error: '未找到' });
  } catch (err) {
    const status = err.statusCode || 500;
    sendJson(res, status, { error: err.message || '服务器内部错误' });
  }
});

export async function start() {
  await loadFromDisk();
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`[web] http://${HOST}:${PORT}  数据目录=${DATA_DIR}`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
