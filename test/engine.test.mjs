// 引擎验收：并发插入相反顺序收敛、祖先撤销后迟到子项、
// 乱序等待仅应用一次、重复投递幂等、篡改/缺父/越界的首个拒因、重开恢复。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Replica,
  converged,
  REJECT,
  fingerprint,
} from '../src/engine.mjs';

const ins = (opId, parent, seq, title = opId) => ({ opId, type: 'insert', parent, seq, title });
const del = (opId, target) => ({ opId, type: 'delete', target });

test('同一父步骤后离线并发插入、相反顺序投递 => 收敛为按 (序号, 操作标识) 排序的相同序列', () => {
  const r1 = new Replica('R1');
  const r2 = new Replica('R2');

  for (const op of [ins('root', null, 0, '根')]) {
    r1.deliver(op);
    r2.deliver(op);
  }

  // 两个副本在同一父步骤 root 后离线并发插入 a/b/c（含同序号 a1/a2）
  const setA = [
    ins('c', 'root', 2, '通道C'),
    ins('a2', 'root', 1, '通道A2'),
    ins('a1', 'root', 1, '通道A1'),
    ins('b', 'root', 3, '通道B'),
  ];
  const setB = [...setA].reverse();

  for (const op of setA) assert.equal(r1.deliver(op).status, 'applied');
  for (const op of setB) assert.equal(r2.deliver(op).status, 'applied');

  const expected = ['root', 'a1', 'a2', 'c', 'b']; // seq:0,1,1,2,3；同序按 opId
  assert.deepEqual(r1.visibleIds(), expected);
  assert.deepEqual(r2.visibleIds(), expected);
  assert.ok(converged([r1, r2]));

  // 与投递顺序无关的另一种交错：每个副本内部再打乱
  const r3 = new Replica('R3');
  r3.deliver(ins('root', null, 0, '根'));
  for (const op of [setA[2], setA[0], setA[3], setA[1]]) r3.deliver(op);
  assert.deepEqual(r3.visibleIds(), expected);
  assert.ok(converged([r1, r2, r3]));
});

test('先撤销祖先、再收到其下合法子步骤：祖先保留为不可见墓碑，子步骤出现在正确位置', () => {
  const r = new Replica('R1');
  r.deliver(ins('root', null, 0, '根'));
  r.deliver(ins('g', 'root', 1, '待撤销组'));
  assert.equal(r.deliver(del('undo-g', 'g')).status, 'applied');

  // g 已是墓碑：不可见
  assert.deepEqual(r.visibleIds(), ['root']);
  assert.deepEqual(r.tombstones().map((t) => t.opId), ['g']);

  // 撤销之后才收到其下合法子步骤 c；c 仍须出现，顶替 g 在 root 下的位置
  assert.equal(r.deliver(ins('c', 'g', 0, '组内校正')).status, 'applied');
  assert.deepEqual(r.visibleIds(), ['root', 'c']);
  // 墓碑依旧存在且只有一个
  assert.deepEqual(r.tombstones().map((t) => t.opId), ['g']);

  // 孙辈同样穿透墓碑，位置正确
  r.deliver(ins('c2', 'g', 1, '组内校正2'));
  r.deliver(ins('gc', 'c', 0, '孙项'));
  assert.deepEqual(r.visibleIds(), ['root', 'c', 'gc', 'c2']);

  // 重复撤销同一墓碑 => TARGET_TOMBSTONED，无新墓碑
  const again = r.deliver(del('undo-g-again', 'g'));
  assert.equal(again.status, 'rejected');
  assert.equal(again.reason, REJECT.TARGET_TOMBSTONED);
  assert.equal(r.tombstones().length, 1);
});

test('乱序操作等待依赖齐备后仅应用一次；重复投递不新增步骤、墓碑或等待项', () => {
  const r = new Replica('R1');

  // 孙项、子项先到，根后到
  assert.equal(r.deliver(ins('gc', 'c', 0, '孙')).status, 'waiting');
  assert.equal(r.deliver(ins('c', 'root', 0, '子')).status, 'waiting');
  assert.equal(r.waiting.size, 2);
  assert.deepEqual(r.visibleIds(), []);

  // 根到达 => fixpoint 链式应用，全部仅一次
  assert.equal(r.deliver(ins('root', null, 0, '根')).status, 'applied');
  assert.equal(r.waiting.size, 0);
  assert.deepEqual(r.visibleIds(), ['root', 'c', 'gc']);
  assert.equal(r.applied.size, 3);

  // 重复投递（同指纹）：不新增任何东西
  for (let i = 0; i < 3; i += 1) {
    const rep = r.deliver(ins('c', 'root', 0, '子'));
    assert.equal(rep.status, 'duplicate');
  }
  assert.deepEqual(r.visibleIds(), ['root', 'c', 'gc']);
  assert.equal(r.applied.size, 3);
  assert.equal(r.tombstones().length, 0);
  assert.equal(r.rejected.size, 0);

  // 乱序的 delete：目标未到时等待，到达后应用一次；重复投递不产生第二块墓碑
  const r2 = new Replica('R2');
  assert.equal(r2.deliver(del('undo-x', 'x')).status, 'waiting');
  assert.equal(r2.deliver(ins('x', null, 0, 'X')).status, 'applied');
  assert.equal(r2.tombstones().length, 1);
  assert.equal(r2.deliver(del('undo-x', 'x')).status, 'duplicate');
  assert.equal(r2.deliver(del('undo-x-copy', 'x')).reason, REJECT.TARGET_TOMBSTONED);
  assert.equal(r2.tombstones().length, 1);
});

test('复用操作标识但篡改载荷：定位首个拒因 REPLAY_CONFLICT，既有投影不变', () => {
  const r = new Replica('R1');
  r.deliver(ins('a', null, 0, '原始A'));
  const before = JSON.stringify(r.visibleSequence());

  // 同一 opId 改标题
  const tamper = r.deliver(ins('a', null, 0, '篡改A'));
  assert.equal(tamper.status, 'rejected');
  assert.equal(tamper.reason, REJECT.REPLAY_CONFLICT);
  assert.equal(JSON.stringify(r.visibleSequence()), before);

  // 同一 opId 改父项/序号也算篡改
  assert.equal(r.deliver(ins('a', 'a', 5, '递归A')).reason, REJECT.REPLAY_CONFLICT);
  // 首拒因列表中该篡改记录可定位（派生键），且原始 a 未被污染
  assert.ok(r.rejectionList()[0].reason === REJECT.REPLAY_CONFLICT);
  assert.deepEqual(r.visibleIds().map((id) => id), ['a']);
  assert.equal(r.nodes.get('a').title, '原始A');
});

test('缺失父项与越界序号：各自的首个拒因可定位，既有投影不变', () => {
  const r = new Replica('R1');
  r.deliver(ins('a', null, 1, 'A'));
  const before = JSON.stringify(r.visibleSequence());

  // 形态校验顺序：父项先于序号。parent 非法且 seq 越界时，首个拒因是 MISSING_PARENT
  const both = r.deliver({ opId: 'bad-1', type: 'insert', parent: '', seq: 999, title: 'x' });
  assert.equal(both.reason, REJECT.MISSING_PARENT);

  // 父项形态合法但永不出现 => 保持等待（离线滞留），封存时才定性
  assert.equal(r.deliver(ins('late', 'ghost', 0, '迟到')).status, 'waiting');

  // 序号越界
  assert.equal(r.deliver(ins('oob', null, 40, '越界上')).reason, REJECT.SEQ_OUT_OF_RANGE);
  assert.equal(r.deliver(ins('oob2', null, -1, '越界下')).reason, REJECT.SEQ_OUT_OF_RANGE);

  // 投影与拒因互不干扰
  assert.equal(JSON.stringify(r.visibleSequence()), before);
  const reasons = r.rejectionList().map((x) => x.reason);
  assert.ok(reasons.includes(REJECT.MISSING_PARENT));
  assert.ok(reasons.includes(REJECT.SEQ_OUT_OF_RANGE));

  // 封存后滞留项定性为缺失父项
  r.seal();
  assert.equal(r.rejected.get('late').reason, REJECT.MISSING_PARENT);
  assert.equal(JSON.stringify(r.visibleSequence()), before);
});

test('父项已被拒绝时子项得到 PARENT_REJECTED；撤销已拒绝目标得到 TARGET_MISSING', () => {
  const r = new Replica('R1');
  r.deliver({ opId: 'bad-parent', type: 'insert', parent: null, seq: 77, title: '坏父' });
  assert.equal(r.deliver(ins('child', 'bad-parent', 0, '子')).reason, REJECT.PARENT_REJECTED);
  assert.equal(r.deliver(del('d-bad', 'bad-parent')).reason, REJECT.TARGET_MISSING);
});

test('刷新/关闭重开（序列化-恢复）：可见序列、等待项、已应用记录一致，且可继续接收滞留合法投递', () => {
  const r = new Replica('R1');
  r.deliver(ins('root', null, 0, '根'));
  r.deliver(ins('c', 'root', 2, 'C'));
  r.deliver(ins('a1', 'root', 1, 'A1'));
  r.deliver(ins('a2', 'root', 1, 'A2'));
  r.deliver(ins('late', 'offline-parent', 0, '滞留子项')); // 等待
  r.deliver(del('undo-c-later', 'c')); // delete 目标存在 => 直接应用

  const data = JSON.parse(JSON.stringify(r.toJSON()));
  const reopened = Replica.restore(data);

  assert.deepEqual(reopened.visibleIds(), r.visibleIds());
  assert.deepEqual(reopened.waitingOps().map((x) => x.opId), ['late']);
  assert.deepEqual([...reopened.applied].sort(), [...r.applied].sort());
  assert.deepEqual(reopened.tombstones().map((t) => t.opId), ['c']);

  // 重开后此前滞留的父项合法投递到达 => 等待项仅应用一次
  const res = reopened.deliver(ins('offline-parent', 'root', 3, '离线归来的父'));
  assert.equal(res.status, 'applied');
  assert.equal(reopened.waiting.size, 0);
  assert.deepEqual(reopened.visibleIds(), ['root', 'a1', 'a2', 'offline-parent', 'late']);

  // 重复投递在重开后依然幂等
  assert.equal(reopened.deliver(ins('a1', 'root', 1, 'A1')).status, 'duplicate');
  assert.deepEqual(reopened.visibleIds(), ['root', 'a1', 'a2', 'offline-parent', 'late']);
});

test('指纹：同标识同载荷字节一致；任一字段变化即视为篡改', () => {
  const base = ins('a', null, 0, 'A');
  assert.equal(fingerprint(base), fingerprint(ins('a', null, 0, 'A')));
  assert.notEqual(fingerprint(base), fingerprint(ins('a', null, 1, 'A')));
  assert.notEqual(fingerprint(base), fingerprint(ins('a', 'root', 0, 'A')));
});
