// 演练编排验收：步骤单解析、按 tick 并发回放、重开恢复后继续接收滞留投递、
// 各副本最终收敛，以及拒绝原因逐副本可查。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheet, Drill, reopen, SheetError } from '../src/drill.mjs';

const SHEET = {
  replicas: ['R1', 'R2'],
  steps: [
    { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根步骤' },
    { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '通道X' },
    { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '通道Y' },
    { opId: 'g', type: 'insert', parent: null, seq: 2, title: '待撤销祖先' },
    { opId: 'c', type: 'insert', parent: 'g', seq: 0, title: '迟到合法子项' },
    { opId: 'del-g', type: 'delete', target: 'g' },
    { opId: 'ghost', type: 'insert', parent: null, seq: 5, title: '离线滞留的父' },
  ],
  scripts: {
    R1: [
      'p', 'x', 'y',
      'g', 'del-g', 'c',
      'late-child', // 内联：先引用未定义，改用对象（见下方替换）
    ],
    R2: [
      'p', 'y', 'x',
      'g', 'c', 'del-g',
      { opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '重开后才齐依赖的子项' },
    ],
  },
};
// R1 的第 7 动作同样内联定义（保持两个副本脚本等长）
SHEET.scripts.R1[6] = {
  opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '重开后才齐依赖的子项',
};

function makeDrill() {
  const sheet = parseSheet(JSON.stringify(SHEET));
  return new Drill('d1', sheet);
}

test('按步骤回放与整段回放结果一致，且两个副本收敛', () => {
  const stepwise = makeDrill();
  while (!stepwise.finished) stepwise.play(1);
  const end1 = stepwise.state();

  const whole = makeDrill();
  const r = whole.play(Infinity);
  assert.equal(r.advanced, 7);
  const end2 = whole.state();

  assert.ok(end1.finished && end2.finished);
  assert.ok(end1.converged && end2.converged);
  // 期望可见序列：p, x, y, c（g 墓碑穿透）
  for (const rid of ['R1', 'R2']) {
    const ids = end1.replicas[rid].visible.map((s) => s.opId);
    assert.deepEqual(ids, ['p', 'x', 'y', 'c']);
    const tombs = end1.replicas[rid].tombstones.map((t) => t.opId);
    assert.deepEqual(tombs, ['g']);
    // late-child 依赖缺失 => 仍在等待
    assert.deepEqual(end1.replicas[rid].waiting.map((w) => w.opId), ['late-child']);
  }
  // 两种回放方式产物逐字节一致（除事件聚合外）
  assert.deepEqual(
    end1.replicas,
    JSON.parse(JSON.stringify(end2.replicas)),
  );
});

test('单步回放的 tick 上并发：同一 tick 两个副本各投递一项', () => {
  const d = makeDrill();
  const { events } = d.play(1);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.replica).sort(), ['R1', 'R2']);
  assert.ok(events.every((e) => e.tick === 1 && e.status === 'applied'));
});

test('重开恢复后：等待项保留、可继续接收此前滞留的合法投递并仅应用一次', () => {
  const d = makeDrill();
  d.play(Infinity);
  const reopened = reopen(d);

  const state = reopened.state();
  for (const rid of ['R1', 'R2']) {
    assert.deepEqual(state.replicas[rid].waiting.map((w) => w.opId), ['late-child']);
    assert.deepEqual(
      state.replicas[rid].visible.map((s) => s.opId),
      ['p', 'x', 'y', 'c'],
    );
  }

  // 滞留的父项 ghost 合法投递到达（两个副本都补投）
  const ghostOp = SHEET.steps.find((s) => s.opId === 'ghost');
  for (const rid of ['R1', 'R2']) {
    const ev = reopened.deliverExtra(rid, ghostOp);
    assert.equal(ev.status, 'applied');
    // late-child 被 fixpoint 链式应用，只出现一次
    const after = reopened.state().replicas[rid];
    assert.deepEqual(after.waiting, []);
    assert.deepEqual(
      after.visible.map((s) => s.opId),
      ['p', 'x', 'y', 'c', 'ghost', 'late-child'],
    );
  }
  assert.ok(reopened.state().converged);

  // 再次重开：已应用记录不丢、不重复
  const again = reopen(reopened);
  for (const rid of ['R1', 'R2']) {
    assert.deepEqual(
      again.state().replicas[rid].visible.map((s) => s.opId),
      ['p', 'x', 'y', 'c', 'ghost', 'late-child'],
    );
  }
});

test('重复投递与故障注入：重复不新增，篡改/越界/缺父各自定位首个拒因', () => {
  const faultSheet = {
    replicas: ['R1', 'R2'],
    steps: [
      { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
      { opId: 'x', type: 'insert', parent: 'p', seq: 0, title: 'X' },
    ],
    scripts: {
      R1: [
        'p', 'x', 'p', 'x', // 重复投递
        { opId: 'x', type: 'insert', parent: 'p', seq: 0, title: '篡改X' },
        { opId: 'oob', type: 'insert', parent: null, seq: 40, title: '越界' },
      ],
      R2: [
        'p', 'x', 'p', 'x',
        { opId: 'x', type: 'insert', parent: 'p', seq: 9, title: '篡改X序号' },
        { opId: 'orphan', type: 'insert', parent: 'nope', seq: 0, title: '孤儿' },
      ],
    },
  };
  const d = new Drill('fault', parseSheet(JSON.stringify(faultSheet)));
  d.play(Infinity);
  const st = d.state();

  for (const rid of ['R1', 'R2']) {
    const snap = st.replicas[rid];
    // 重复投递不新增步骤
    assert.deepEqual(snap.visible.map((s) => s.opId), ['p', 'x']);
    // 篡改可定位
    assert.ok(snap.rejected.some((r) => r.reason === 'REPLAY_CONFLICT'));
  }
  assert.ok(st.replicas.R1.rejected.some((r) => r.reason === 'SEQ_OUT_OF_RANGE'));
  // orphan 的父从未出现：保持等待而非硬拒绝
  assert.deepEqual(st.replicas.R2.waiting.map((w) => w.opId), ['orphan']);

  // 日志中重复投递记录为 duplicate，且无任何副作用
  const dupEvents = st.log.filter((e) => e.status === 'duplicate');
  assert.ok(dupEvents.length >= 4);
});

test('步骤单校验：副本数量、动作上限、非法引用', () => {
  assert.throws(
    () => parseSheet(JSON.stringify({ replicas: ['R1'], steps: [], scripts: {} })),
    (e) => e instanceof SheetError && e.code === 'SHEET_REPLICA_COUNT',
  );
  // 合法长度内引用未定义步骤 => UNKNOWN_REF
  assert.throws(
    () => parseSheet(JSON.stringify({
      replicas: ['R1', 'R2'],
      steps: [],
      scripts: { R1: ['x'], R2: [] },
    })),
    (e) => e instanceof SheetError && e.code === 'SHEET_UNKNOWN_REF',
  );
  // 41 个内联坏动作 => 动作数超限（在逐项处理前先检查长度）
  const longList = Array.from({ length: 41 }, (_, i) => ({
    opId: `z${i}`, type: 'insert', parent: null, seq: i, title: 'z',
  }));
  assert.throws(
    () => parseSheet(JSON.stringify({ replicas: ['R1', 'R2'], steps: [], scripts: { R1: longList, R2: [] } })),
    (e) => e instanceof SheetError && e.code === 'SHEET_TOO_MANY_ACTIONS',
  );
});

test('reset 后重新整段回放得到相同投影', () => {
  const d = makeDrill();
  d.play(Infinity);
  const first = JSON.stringify(d.state().replicas);
  d.reset();
  d.play(Infinity);
  const second = JSON.stringify(d.state().replicas);
  assert.equal(first, second);
});
