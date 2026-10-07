/* 副本回放台前端：零依赖原生 JS。 */

const $ = (sel) => document.querySelector(sel);

const SAMPLE = {
  replicas: ['R1', 'R2'],
  steps: [
    { opId: 'p', type: 'insert', parent: null, seq: 0, title: '点火后初制导' },
    { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '并联通道 X' },
    { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '并联通道 Y' },
    { opId: 'g', type: 'insert', parent: null, seq: 2, title: '中段修正组（将撤销）' },
    { opId: 'c', type: 'insert', parent: 'g', seq: 0, title: '组内姿态校正（迟到合法子项）' },
    { opId: 'del-g', type: 'delete', target: 'g' },
    { opId: 'b', type: 'insert', parent: null, seq: 3, title: '末修段' },
    { opId: 'd', type: 'insert', parent: 'b', seq: 0, title: '末修子项（先于父项到达）' },
  ],
  scripts: {
    // R1：x 在 y 前投递；祖先 g 先撤销，合法子项 c 后到
    R1: [
      'p', 'x', 'y',
      'g', 'del-g', 'c',
      'd', 'b',
      'p', // 重复投递：幂等，不新增步骤
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '被篡改的 X 载荷' },
      { opId: 'oob-1', type: 'insert', parent: null, seq: 99, title: '序号越界' },
      { opId: 'orphan-1', type: 'insert', parent: 'ghost', seq: 0, title: '父项永缺' },
      { opId: 'del-ghost', type: 'delete', target: 'ghost' },
    ],
    // R2：同层并联步骤以相反顺序投递；g 的子项先到、撤销后到
    R2: [
      'p', 'y', 'x',
      'g', 'c', 'del-g',
      'd', 'b',
      'g',
      { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '被篡改的 Y 载荷' },
      { opId: 'oob-2', type: 'insert', parent: null, seq: -1, title: '序号越界' },
      { opId: 'orphan-2', type: 'insert', parent: 'ghost', seq: 1, title: '父项永缺' },
      { opId: 'del-ghost', type: 'delete', target: 'ghost' },
    ],
  },
};

let state = null;
let currentId = localStorage.getItem('drill-id') || null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

function showError(msg) {
  const box = $('#sheet-error');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

function setControls() {
  const active = !!state;
  const ended = state && (state.finished || state.sealed);
  $('#btn-step').disabled = !active || ended;
  $('#btn-all').disabled = !active || ended;
  $('#btn-reset').disabled = !active;
  $('#btn-seal').disabled = !active || state.sealed;
  $('#btn-deliver').disabled = !active;
  $('#extra-replica').innerHTML = active
    ? state.replicaIds.map((id) => `<option>${esc(id)}</option>`).join('')
    : '';
}

function renderMeta() {
  const el = $('#stage-meta');
  if (!state) { el.textContent = '尚未创建演练'; return; }
  el.innerHTML =
    `tick <b>${state.tick}</b>/<b>${state.length}</b> · ` +
    (state.sealed
      ? '<span class="diverged">已封存</span>'
      : state.finished ? '<span class="diverged">脚本投递完毕（可封存或继续零散投递）</span>' : '进行中') +
    ' · 可见序列：' +
    (state.converged
      ? '<span class="converged">各副本已收敛一致 ✓</span>'
      : '<span class="diverged">副本间尚未收敛</span>');
}

function renderReplica(rid, snap) {
  const visible = snap.visible.map((s) =>
    `<div class="step" style="padding-left:${8 + s.depth * 16}px">` +
    `<span class="seq">[${s.seq}]</span>` +
    `<span>${esc(s.title)}</span>` +
    `<span class="oid">${esc(s.opId)}</span></div>`).join('') ||
    '<div class="empty">（暂无可见步骤）</div>';

  const tombs = snap.tombstones.map((t) =>
    `<div class="tomb-item">⚰ <s>${esc(t.title)}</s> ` +
    `<span class="oid">${esc(t.opId)}</span> 被 ${esc(t.deletedBy)} 撤销（不可见墓碑）</div>`).join('')
    || '<div class="empty">（无墓碑）</div>';

  const waiting = snap.waiting.map((w) =>
    `<div class="wait-item">⏳ ${esc(w.opId)} 等待依赖：${w.type === 'insert' ? `父项 ${esc(w.parent)}` : `撤销目标 ${esc(w.target)}`}</div>`).join('')
    || '<div class="empty">（无等待操作）</div>';

  const rejects = snap.rejected.length
    ? snap.rejected.map((r, i) =>
        `<div class="reject-item">${i === 0 ? '🚫 首个拒因 → ' : '· '}` +
        `<b>${esc(r.label)}</b> <span class="oid">${esc(r.opId)}</span></div>`).join('')
    : '<div class="empty">（无拒绝）</div>';

  return `<div class="replica">
    <h3>${esc(rid)}
      <span class="pill">可见 ${snap.visible.length}</span>
      <span class="pill">等待 ${snap.waiting.length}</span>
      <span class="pill">墓碑 ${snap.tombstones.length}</span>
      <span class="pill">已应用 ${snap.applied.length}</span>
    </h3>
    <div class="section-label">可见步骤（稳定序列）</div>${visible}
    <div class="section-label">等待操作</div>${waiting}
    <div class="section-label">墓碑</div>${tombs}
    <div class="section-label">拒绝记录</div>${rejects}
  </div>`;
}

function tag(status) {
  const cls = `tag-${status}`;
  const text = { applied: '已应用', duplicate: '重复·忽略', waiting: '进入等待', rejected: '已拒绝' }[status] || status;
  return `<span class="${cls}">${text}</span>`;
}

const REASON_TEXT = {
  BAD_SHAPE: '操作格式错误',
  BAD_OP_ID: '稳定操作标识非法',
  REPLAY_CONFLICT: '复用标识但载荷被篡改',
  MISSING_PARENT: '缺失父项',
  PARENT_REJECTED: '父项已被拒绝',
  SEQ_OUT_OF_RANGE: '序号越界',
  TARGET_MISSING: '撤销目标缺失',
  TARGET_TOMBSTONED: '目标已是墓碑',
  SEALED: '演练已封存',
};

function renderLog() {
  const tbody = $('#log-table tbody');
  tbody.innerHTML = state.log.map((e) =>
    `<tr>
      <td>${e.tick ?? '—'}</td>
      <td class="code">${esc(e.replica)}</td>
      <td>${esc(e.title)}${e.ref ? ` <span class="oid">${esc(e.ref)}</span>` : ''}</td>
      <td>${tag(e.status)}</td>
      <td class="tag-rejected">${e.reason ? esc(REASON_TEXT[e.reason] || e.reason) : ''}</td>
    </tr>`).join('');
}

function render() {
  if (!state) {
    $('#replicas').innerHTML = '';
  } else {
    $('#replicas').innerHTML = state.replicaIds
      .map((rid) => renderReplica(rid, state.replicas[rid])).join('');
  }
  renderMeta();
  renderLog();
  setControls();
}

async function refresh() {
  if (!currentId) return;
  try {
    state = await api('GET', `/api/drills/${currentId}`);
    render();
  } catch {
    state = null;
    currentId = null;
    localStorage.removeItem('drill-id');
    render();
  }
}

$('#btn-sample').addEventListener('click', () => {
  $('#sheet').value = JSON.stringify(SAMPLE, null, 2);
  showError('');
});

$('#btn-create').addEventListener('click', async () => {
  try {
    const created = await api('POST', '/api/drills', { sheet: $('#sheet').value });
    currentId = created.id;
    localStorage.setItem('drill-id', currentId);
    state = created;
    showError('');
    render();
  } catch (err) {
    showError(`${err.message}${err.payload?.code ? `（${err.payload.code}）` : ''}`);
  }
});

$('#btn-step').addEventListener('click', async () => {
  const r = await api('POST', `/api/drills/${currentId}/play`, { steps: 1 });
  state = r.state; render();
});

$('#btn-all').addEventListener('click', async () => {
  const r = await api('POST', `/api/drills/${currentId}/play`, { steps: 'all' });
  state = r.state; render();
});

$('#btn-reset').addEventListener('click', async () => {
  state = await api('POST', `/api/drills/${currentId}/reset`);
  render();
});

$('#btn-seal').addEventListener('click', async () => {
  state = await api('POST', `/api/drills/${currentId}/seal`);
  render();
});

$('#btn-deliver').addEventListener('click', async () => {
  let op;
  try {
    op = JSON.parse($('#extra-op').value);
  } catch {
    showError('零散投递的操作不是合法 JSON');
    return;
  }
  try {
    const r = await api('POST', `/api/drills/${currentId}/deliver`, {
      replica: $('#extra-replica').value,
      op,
    });
    state = r.state;
    showError('');
    render();
  } catch (err) {
    showError(err.message);
  }
});

async function pollHealth() {
  const el = $('#health');
  try {
    const h = await api('GET', '/healthz');
    el.textContent = `健康检查：正常（已保存演练 ${h.drills} 个）`;
    el.className = 'health ok';
  } catch {
    el.textContent = '健康检查：失败';
    el.className = 'health bad';
  }
}

async function boot() {
  $('#sheet').value = JSON.stringify(SAMPLE, null, 2);
  await pollHealth();
  setInterval(pollHealth, 5000);
  try {
    const list = await api('GET', '/api/drills');
    if (list.drills.length) {
      currentId = list.drills[list.drills.length - 1].id;
      localStorage.setItem('drill-id', currentId);
      await refresh();
      return;
    }
  } catch { /* 全新启动 */ }
  render();
}

boot();
