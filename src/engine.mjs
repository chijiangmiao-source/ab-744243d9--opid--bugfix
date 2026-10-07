// 姿控步骤单演练引擎：每个副本（Replica）独立维护
// seen(已见操作指纹) / applied(已应用) / waiting(等待依赖) / rejected(首个拒因)
// / nodes(步骤节点与墓碑)。投递幂等，乱序操作在依赖齐备后的 fixpoint 中仅应用一次。

import { createHash } from 'node:crypto';

export const MAX_ACTIONS = 40; // 单张步骤单最多 40 个生成/投递动作
export const MIN_REPLICAS = 2;
export const MAX_REPLICAS = 4;
export const MAX_SEQ = 39; // 序号合法区间 [0, 39]

export const REJECT = {
  BAD_SHAPE: 'BAD_SHAPE',
  BAD_OP_ID: 'BAD_OP_ID',
  REPLAY_CONFLICT: 'REPLAY_CONFLICT',
  MISSING_PARENT: 'MISSING_PARENT',
  PARENT_REJECTED: 'PARENT_REJECTED',
  SEQ_OUT_OF_RANGE: 'SEQ_OUT_OF_RANGE',
  TARGET_MISSING: 'TARGET_MISSING',
  TARGET_TOMBSTONED: 'TARGET_TOMBSTONED',
  SEALED: 'SEALED',
};

export const REJECT_LABEL = {
  BAD_SHAPE: '操作格式错误',
  BAD_OP_ID: '稳定操作标识非法',
  REPLAY_CONFLICT: '复用操作标识但载荷被篡改',
  MISSING_PARENT: '缺失父项',
  PARENT_REJECTED: '父项已被拒绝（等效缺失父项）',
  SEQ_OUT_OF_RANGE: '序号越界',
  TARGET_MISSING: '撤销目标缺失或已被拒绝',
  TARGET_TOMBSTONED: '撤销目标已是墓碑',
  SEALED: '演练流已封存，副本不再接收投递',
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

// 规范化后的操作指纹：同一稳定标识 + 同一规范字节 => 重复投递；字节不同 => 篡改
export function canonicalOp(op) {
  if (op.type === 'delete') {
    return JSON.stringify({
      opId: op.opId,
      type: 'delete',
      target: op.target,
    });
  }
  return JSON.stringify({
    opId: op.opId,
    type: 'insert',
    parent: op.parent,
    seq: op.seq,
    title: op.title,
  });
}

export function fingerprint(op) {
  return createHash('sha256').update(canonicalOp(op)).digest('hex');
}

// 形态级校验（与副本上下文无关）。校验顺序即“首个拒因”的定位顺序：
// 形态 -> 标识 -> 类型专属字段（insert: 父项 -> 序号 -> 标题；delete: 目标）
export function normalizeOp(raw) {
  if (!isPlainObject(raw)) {
    return { error: REJECT.BAD_SHAPE };
  }
  if (!validId(raw.opId)) {
    return { error: REJECT.BAD_OP_ID };
  }
  const opId = raw.opId;
  if (raw.type === 'insert') {
    if (!('parent' in raw)) {
      return { opId, error: REJECT.MISSING_PARENT };
    }
    const parent = raw.parent === null ? null : raw.parent;
    if (parent !== null && !validId(parent)) {
      return { opId, error: REJECT.MISSING_PARENT };
    }
    if (
      typeof raw.seq !== 'number' ||
      !Number.isInteger(raw.seq) ||
      raw.seq < 0 ||
      raw.seq > MAX_SEQ
    ) {
      return { opId, error: REJECT.SEQ_OUT_OF_RANGE };
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) {
      return { opId, error: REJECT.BAD_SHAPE };
    }
    return {
      op: { opId, type: 'insert', parent, seq: raw.seq, title },
    };
  }
  if (raw.type === 'delete') {
    if (!validId(raw.target)) {
      return { opId, error: REJECT.TARGET_MISSING };
    }
    return { op: { opId, type: 'delete', target: raw.target } };
  }
  return { opId, error: REJECT.BAD_SHAPE };
}

export class Replica {
  constructor(id) {
    this.id = id;
    this.seen = new Map(); // opId -> 首次见到的指纹
    this.nodes = new Map(); // opId -> {opId,parent,seq,title,deleted,deletedBy}
    this.applied = new Set(); // 已生效的操作标识（insert/delete）
    this.rejected = new Map(); // opId -> {reason, op, at}
    this.waiting = new Map(); // opId -> 规范化后的 op
    this.deliveryCount = 0;
    this._invalidCount = 0;
    this.sealed = false; // 封存后拒绝一切新投递（已滞留等待项不受影响）
  }

  // 投递一个操作。返回 {status, reason?, opId?}
  // status: applied | waiting | rejected | duplicate
  deliver(rawOp, at = null) {
    if (this.sealed) {
      return { status: 'rejected', reason: REJECT.SEALED, opId: rawOp?.opId ?? null };
    }
    this.deliveryCount += 1;
    const when = at ?? this.deliveryCount;
    const norm = normalizeOp(rawOp);

    if (norm.error) {
      const key = norm.opId ?? `__invalid_${++this._invalidCount}__`;
      // 无有效标识的坏操作：逐个留痕，但不影响任何投影
      if (!this.rejected.has(key)) {
        this.rejected.set(key, { reason: norm.error, op: rawOp, at: when });
      }
      return { status: 'rejected', reason: norm.error, opId: norm.opId ?? null };
    }

    const op = norm.op;
    const { opId } = op;
    const fp = fingerprint(op);

    if (this.seen.has(opId)) {
      // 复用操作标识：
      //  - 同指纹 => 幂等重复，不新增步骤/墓碑，等待项也不重复入队
      //  - 异指纹 => 载荷篡改；以派生键留痕并定位拒因，
      //    不触碰原标识的 seen/applied/waiting，既有投影保持不变
      if (this.seen.get(opId) === fp) {
        if (this.waiting.has(opId)) return { status: 'waiting', opId, duplicate: true };
        if (this.rejected.has(opId)) {
          return { status: 'rejected', reason: this.rejected.get(opId).reason, opId, duplicate: true };
        }
        return { status: 'duplicate', opId };
      }
      const tamperKey = `${opId}#tampered#${fp.slice(0, 12)}`;
      if (!this.rejected.has(tamperKey)) {
        this.rejected.set(tamperKey, { reason: REJECT.REPLAY_CONFLICT, op, at: when });
      }
      return { status: 'rejected', reason: REJECT.REPLAY_CONFLICT, opId };
    }

    // 首次见到该标识，记录指纹
    this.seen.set(opId, fp);

    const contextual = this._contextualError(op);
    if (contextual === 'wait') {
      this.waiting.set(opId, op);
      this._fixpoint();
      return { status: this.waiting.has(opId) ? 'waiting' : this._statusOf(opId), opId };
    }
    if (contextual) {
      this.rejected.set(opId, { reason: contextual, op, at: when });
      this._fixpoint();
      return { status: 'rejected', reason: contextual, opId };
    }

    this._apply(op, when);
    this._fixpoint();
    return { status: this._statusOf(opId), opId };
  }

  _statusOf(opId) {
    if (this.applied.has(opId)) return 'applied';
    if (this.waiting.has(opId)) return 'waiting';
    if (this.rejected.has(opId)) return 'rejected';
    return 'unknown';
  }

  // 返回 null 表示依赖齐备可应用；'wait' 表示依赖未齐；其它为硬拒因
  _contextualError(op) {
    if (op.type === 'insert') {
      if (op.parent === null) return null;
      if (this.rejected.has(op.parent)) return REJECT.PARENT_REJECTED;
      if (!this.nodes.has(op.parent)) {
        // 父项可能是尚在等待的操作；若父操作在等待队列，则随其一起等待，
        // 否则父标识从未出现（离线滞留），保持等待，待日后合法投递到达。
        return 'wait';
      }
      return null;
    }
    // delete
    if (this.rejected.has(op.target)) return REJECT.TARGET_MISSING;
    const node = this.nodes.get(op.target);
    if (!node) return 'wait'; // 目标未到（可能在等待队列或尚未投递）
    if (node.deleted) return REJECT.TARGET_TOMBSTONED;
    return null;
  }

  _apply(op, at) {
    if (op.type === 'insert') {
      this.nodes.set(op.opId, {
        opId: op.opId,
        parent: op.parent,
        seq: op.seq,
        title: op.title,
        deleted: false,
        deletedBy: null,
        insertedAt: at,
      });
    } else {
      const node = this.nodes.get(op.target);
      node.deleted = true;
      node.deletedBy = op.opId;
      node.deletedAt = at;
    }
    this.applied.add(op.opId);
  }

  // 依赖齐备后反复收敛等待队列；每个操作最多应用一次
  _fixpoint() {
    let progressed = true;
    let guard = 0;
    while (progressed && guard <= 1000) {
      progressed = false;
      guard += 1;
      for (const [opId, op] of [...this.waiting]) {
        const verdict = this._contextualError(op);
        if (verdict === 'wait') continue;
        this.waiting.delete(opId);
        if (verdict) {
          this.rejected.set(opId, { reason: verdict, op });
        } else {
          this._apply(op, this.deliveryCount);
        }
        progressed = true;
      }
    }
  }

  // 封存判定：演练流自然结束时，仍滞留的等待项按其始终缺失的依赖
  // 定性为最终拒因（insert -> 父项缺失/父项被拒；delete -> 目标缺失）。
  // 注意刷新/关闭不等于封存；封存是显式动作。
  seal() {
    this.sealed = true;
    for (const [opId, op] of [...this.waiting]) {
      this.waiting.delete(opId);
      const reason =
        op.type === 'insert'
          ? this.rejected.has(op.parent)
            ? REJECT.PARENT_REJECTED
            : REJECT.MISSING_PARENT
          : REJECT.TARGET_MISSING;
      this.rejected.set(opId, { reason, op, sealed: true });
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      id: this.id,
      sealed: this.sealed,
      deliveryCount: this.deliveryCount,
      visible: this.visibleSequence(),
      waiting: this.waitingOps(),
      tombstones: this.tombstones(),
      rejected: this.rejectionList(),
      applied: [...this.applied],
    };
  }

  toJSON() {
    return {
      id: this.id,
      sealed: this.sealed,
      deliveryCount: this.deliveryCount,
      seen: [...this.seen.entries()],
      nodes: [...this.nodes.values()],
      applied: [...this.applied],
      rejected: [...this.rejected.entries()],
      waiting: [...this.waiting.values()],
    };
  }

  static restore(data) {
    const r = new Replica(data.id);
    r.sealed = !!data.sealed;
    r.deliveryCount = data.deliveryCount ?? 0;
    r.seen = new Map(data.seen ?? []);
    r.nodes = new Map((data.nodes ?? []).map((n) => [n.opId, n]));
    r.applied = new Set(data.applied ?? []);
    r.rejected = new Map(data.rejected ?? []);
    r.waiting = new Map((data.waiting ?? []).map((op) => [op.opId, op]));
    return r;
  }

  _childrenOf(parent) {
    const out = [];
    for (const node of this.nodes.values()) {
      if (node.parent === parent) out.push(node);
    }
    // 稳定排序：同层按 (序号, 稳定操作标识)，与投递顺序无关
    out.sort((a, b) => a.seq - b.seq || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
    return out;
  }

  // 可见序列的扁平投影：墓碑节点本身不可见，但其子孙在原位置接续展开
  visibleSequence() {
    const out = [];
    const walk = (parent, visibleDepth) => {
      for (const node of this._childrenOf(parent)) {
        if (!node.deleted) {
          out.push({
            opId: node.opId,
            parent: node.parent,
            seq: node.seq,
            title: node.title,
            depth: visibleDepth,
          });
          walk(node.opId, visibleDepth + 1);
        } else {
          // 祖先不可见：子步骤仍须出现在正确位置（顶替墓碑展开）
          walk(node.opId, visibleDepth);
        }
      }
    };
    walk(null, 0);
    return out;
  }

  visibleIds() {
    return this.visibleSequence().map((s) => s.opId);
  }

  // 墓碑按树的稳定遍历顺序排列
  tombstones() {
    const out = [];
    const walk = (parent) => {
      for (const node of this._childrenOf(parent)) {
        if (node.deleted) {
          out.push({
            opId: node.opId,
            parent: node.parent,
            seq: node.seq,
            title: node.title,
            deletedBy: node.deletedBy,
          });
        }
        walk(node.opId);
      }
    };
    walk(null);
    return out;
  }

  waitingOps() {
    return [...this.waiting.values()].map((op) => ({ ...op }));
  }

  rejectionList() {
    return [...this.rejected.entries()].map(([opId, r]) => ({
      opId,
      reason: r.reason,
      label: REJECT_LABEL[r.reason] ?? r.reason,
      op: r.op,
    }));
  }
}

// 判断若干副本是否已收敛为同一可见步骤序列
export function converged(replicas) {
  if (replicas.length === 0) return true;
  const base = JSON.stringify(replicas[0].visibleIds());
  return replicas.every((r) => JSON.stringify(r.visibleIds()) === base);
}
