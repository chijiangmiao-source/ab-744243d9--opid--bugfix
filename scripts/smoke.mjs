// HTTP 冒烟：
//  1) GET /healthz 必须 200 且 ok=true
//  2) GET / 页面必须 200 且包含挂载点与资源引用
//  3) API 端到端：建演练 -> 整段回放 -> 断言收敛/墓碑/等待/首拒因
//  4) 重启恢复：重启服务（同一数据目录）后投影与等待项一致，再补投滞留合法操作
//
// 若设置了 BASE_URL，则直接对该地址冒烟（Compose 中 verify 依赖 web）；
// 否则在本地临时端口拉起服务自测。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const EXTERNAL_BASE = process.env.BASE_URL || '';
let child = null;
let tmpDir = null;
let failures = 0;

function fail(msg) {
  failures += 1;
  console.error(`✗ ${msg}`);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr?.message ?? 'healthz 非 200'}`);
}

async function startServer() {
  if (EXTERNAL_BASE) return EXTERNAL_BASE;
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'drill-smoke-'));
  const port = 8900 + Math.floor(Math.random() * 800);
  child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(tmpDir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return base;
}

async function stopServer() {
  if (!child) return;
  await new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 2000);
  });
  child = null;
}

async function restartServer(prevBase) {
  await stopServer();
  const port = new URL(prevBase).port;
  child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: path.join(tmpDir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

const SHEET = {
  replicas: ['R1', 'R2'],
  steps: [
    { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
    { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '通道X' },
    { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '通道Y' },
    { opId: 'g', type: 'insert', parent: null, seq: 2, title: '待撤销祖先' },
    { opId: 'c', type: 'insert', parent: 'g', seq: 0, title: '迟到合法子项' },
    { opId: 'del-g', type: 'delete', target: 'g' },
    { opId: 'ghost', type: 'insert', parent: null, seq: 4, title: '滞留后补的父' },
  ],
  scripts: {
    R1: ['p', 'x', 'y', 'g', 'del-g', 'c',
      { opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '滞留子项' },
      'p',
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '篡改' },
      { opId: 'oob', type: 'insert', parent: null, seq: 99, title: '越界' }],
    R2: ['p', 'y', 'x', 'g', 'c', 'del-g',
      { opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '滞留子项' },
      'y',
      { opId: 'y', type: 'insert', parent: 'p', seq: 2, title: '篡改' },
      { opId: 'orphan', type: 'insert', parent: 'never', seq: 0, title: '孤儿' }],
  },
};

async function main() {
  const base = await startServer();
  console.log(`冒烟目标：${base}`);

  // 1) 健康接口
  {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, 'GET /healthz 返回 200 且 ok=true');
  }

  // 2) 页面
  {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert(res.status === 200 && html.includes('姿控步骤单演练'), 'GET / 返回页面且标题正确');
    assert(html.includes('/app.js') && html.includes('/app.css'), '页面引用 app.js / app.css');
    const js = await fetch(`${base}/app.js`);
    assert(js.status === 200 && (await js.text()).includes('renderReplica'), 'GET /app.js 返回前端脚本');
  }

  // 3) API 端到端
  let drillId;
  {
    const res = await fetch(`${base}/api/drills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: JSON.stringify(SHEET) }),
    });
    assert(res.status === 201, 'POST /api/drills 创建演练 201');
    const drill = await res.json();
    drillId = drill.id;
  }

  {
    const res = await fetch(`${base}/api/drills/${drillId}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 'all' }),
    });
    const { state } = await res.json();
    assert(state.converged === true, '并发插入相反顺序投递后，两副本收敛为同一可见序列');
    for (const rid of ['R1', 'R2']) {
      const snap = state.replicas[rid];
      const ids = snap.visible.map((s) => s.opId);
      assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c']),
        `${rid} 可见序列为 p,x,y,c（祖先 g 墓碑穿透，子项 c 在正确位置）`);
      assert(snap.tombstones.map((t) => t.opId).join() === 'g', `${rid} g 保留为不可见墓碑`);
      assert(snap.waiting.some((w) => w.opId === 'late-child'), `${rid} late-child 仍在等待`);
      assert(snap.rejected.some((r) => r.reason === 'REPLAY_CONFLICT'), `${rid} 定位到篡改首拒因`);
    }
    assert(state.replicas.R1.rejected.some((r) => r.reason === 'SEQ_OUT_OF_RANGE'), 'R1 定位到越界首拒因');
    // 重复投递未新增：可见始终只有 p,x,y,c
  }

  // 3b) 非法首投递的操作标识不得被后续异载荷顶替（零散投递入口 /deliver）
  const bindSheet = {
    replicas: ['R1', 'R2'],
    steps: [{ opId: 'root', type: 'insert', parent: null, seq: 0, title: '根' }],
    scripts: { R1: ['root'], R2: ['root'] },
  };
  const bindIllegal = { opId: 'x', type: 'insert', parent: 'root', seq: 40, title: '越界载荷' };
  const bindOther = { opId: 'x', type: 'insert', parent: 'root', seq: 1, title: '合法但不同' };
  let bindId;
  {
    const res = await fetch(`${base}/api/drills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: JSON.stringify(bindSheet) }),
    });
    assert(res.status === 201, 'POST /api/drills 创建标识绑定回归演练 201');
    bindId = (await res.json()).id;
    const played = await fetch(`${base}/api/drills/${bindId}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 'all' }),
    });
    const playedState = (await played.json()).state;
    assert(JSON.stringify(playedState.replicas.R1.visible.map((s) => s.opId)) === JSON.stringify(['root']),
      '标识绑定回归演练先回放根步骤 root');
  }
  async function deliverBind(baseUrl, op) {
    const res = await fetch(`${baseUrl}/api/drills/${bindId}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replica: 'R1', op }),
    });
    return res.json();
  }
  {
    const { event, state } = await deliverBind(base, bindIllegal);
    assert(event.status === 'rejected' && event.reason === 'SEQ_OUT_OF_RANGE',
      '首次越界插入被拒 SEQ_OUT_OF_RANGE');
    assert(JSON.stringify(state.replicas.R1.visible.map((s) => s.opId)) === JSON.stringify(['root']),
      '越界拒绝不改变可见步骤');
  }
  {
    const { event, state } = await deliverBind(base, bindOther);
    assert(event.status === 'rejected' && event.reason === 'REPLAY_CONFLICT',
      '同一标识改用合法但不同载荷 => REPLAY_CONFLICT');
    const snap = state.replicas.R1;
    assert(JSON.stringify(snap.visible.map((s) => s.opId)) === JSON.stringify(['root']),
      '冲突不改变可见步骤（仍只有 root）');
    assert(!snap.applied.includes('x'), 'x 不得进入已应用记录');
    assert(snap.rejected.some((r) => r.opId === 'x' && r.reason === 'SEQ_OUT_OF_RANGE'),
      '原标识首个拒因保留为 SEQ_OUT_OF_RANGE');
    assert(snap.rejected.some((r) => String(r.opId).startsWith('x#tampered#')),
      '篡改仅以派生键留痕，不污染原标识');
  }
  {
    const { event } = await deliverBind(base, bindIllegal);
    assert(event.status === 'rejected' && event.reason === 'SEQ_OUT_OF_RANGE' && event.duplicate === true,
      '原始非法载荷重放保持一致的幂等拒绝');
  }

  // 4) 重启恢复 + 补投滞留合法操作
  if (!EXTERNAL_BASE) {
    const restartedBase = await restartServer(base);
    {
      const res = await fetch(`${restartedBase}/api/drills/${drillId}`);
      const state = await res.json();
      for (const rid of ['R1', 'R2']) {
        const ids = state.replicas[rid].visible.map((s) => s.opId);
        assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c']),
          `重启后 ${rid} 可见序列恢复一致`);
        assert(state.replicas[rid].waiting.some((w) => w.opId === 'late-child'),
          `重启后 ${rid} 等待操作恢复`);
      }
    }
    for (const rid of ['R1', 'R2']) {
      const res = await fetch(`${restartedBase}/api/drills/${drillId}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replica: rid, op: SHEET.steps.find((s) => s.opId === 'ghost') }),
      });
      const { state } = await res.json();
      const ids = state.replicas[rid].visible.map((s) => s.opId);
      assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c', 'ghost', 'late-child']),
        `重开补投后 ${rid} 滞留子项被链式应用且仅一次`);
    }

    // 标识绑定回归：恢复后语义与恢复前一致，不得出现“已应用又被拒绝”
    {
      const { event, state } = await deliverBind(restartedBase, bindIllegal);
      assert(event.status === 'rejected'
        && event.reason === 'SEQ_OUT_OF_RANGE'
        && event.duplicate === true,
        '重启后重投原始被拒载荷保持 SEQ_OUT_OF_RANGE（幂等拒绝）');
      assert(JSON.stringify(state.replicas.R1.visible.map((s) => s.opId)) === JSON.stringify(['root']),
        '重启后冲突不改变可见步骤（仍只有 root）');
    }
    {
      const { event, state } = await deliverBind(restartedBase, bindOther);
      assert(event.status === 'rejected' && event.reason === 'REPLAY_CONFLICT',
        '重启后同标识异载荷重放仍为 REPLAY_CONFLICT');
      assert(!state.replicas.R1.applied.includes('x'),
        '重启后 x 不得同时呈现已应用与被拒绝的矛盾语义');
    }

    const finalRes = await fetch(`${restartedBase}/api/drills/${drillId}`);
    const finalState = await finalRes.json();
    assert(finalState.converged === true, '补投后两副本再次收敛');
  } else {
    console.log('（外部 BASE_URL 模式：跳过进程重启恢复检查，由代码测试覆盖）');
  }

  await stopServer();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });

  if (failures) {
    console.error(`\n冒烟失败：${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部冒烟检查通过。');
}

main().catch(async (err) => {
  console.error('冒烟脚本异常：', err);
  await stopServer();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
