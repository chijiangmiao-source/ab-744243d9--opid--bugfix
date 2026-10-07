// 步骤单演练编排：解析审查员粘贴的步骤单，构造 2~4 个副本的投递脚本，
// 按全局 tick 并发回放（同一 tick 内各副本各投递一项），记录操作日志，
// 并支持封存、重开后的零散合法投递，以及从序列化状态恢复（模拟刷新/关闭重开）。

import {
  Replica,
  fingerprint,
  normalizeOp,
  MAX_ACTIONS,
  MIN_REPLICAS,
  MAX_REPLICAS,
  REJECT,
} from './engine.mjs';

export class SheetError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
  }
}

const DEFAULT_REPLICAS = ['R1', 'R2'];

export function parseSheet(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new SheetError('SHEET_NOT_JSON', '步骤单不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SheetError('SHEET_BAD_SHAPE', '步骤单顶层须为对象');
  }

  const replicaIds = Array.isArray(data.replicas) && data.replicas.length
    ? data.replicas.map(String)
    : DEFAULT_REPLICAS.slice();
  const unique = new Set(replicaIds);
  if (replicaIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id))) {
    throw new SheetError('SHEET_BAD_REPLICA_ID', '副本标识非法');
  }
  if (unique.size !== replicaIds.length) {
    throw new SheetError('SHEET_DUP_REPLICA', '副本标识重复');
  }
  if (replicaIds.length < MIN_REPLICAS || replicaIds.length > MAX_REPLICAS) {
    throw new SheetError(
      'SHEET_REPLICA_COUNT',
      `副本数须在 ${MIN_REPLICAS}~${MAX_REPLICAS} 之间`,
    );
  }

  // 步骤定义表：opId -> 规范化操作（静态校验全部形态，但不做上下文判定）
  const defs = new Map();
  const stepList = Array.isArray(data.steps) ? data.steps : [];
  for (const raw of stepList) {
    const norm = normalizeOp(raw);
    if (norm.error) {
      throw new SheetError(
        'SHEET_BAD_STEP',
        `步骤 ${JSON.stringify(raw?.opId ?? raw)} 定义不合法：${norm.error}`,
      );
    }
    if (defs.has(norm.op.opId)) {
      throw new SheetError('SHEET_DUP_STEP', `步骤标识重复：${norm.op.opId}`);
    }
    defs.set(norm.op.opId, norm.op);
  }

  // 投递脚本：每个副本一张有序动作表，动作可以是：
  //   - 字符串：引用 steps 中的定义（重复字符串=重复投递，合法幂等测试）
  //   - 对象：内联操作（用于篡改载荷、缺失父项、越界序号等故障注入）
  const scripts = {};
  const scriptSource = data.scripts ?? data.plays ?? {};
  for (const id of replicaIds) {
    const list = Array.isArray(scriptSource[id]) ? scriptSource[id] : [];
    if (list.length > MAX_ACTIONS) {
      throw new SheetError(
        'SHEET_TOO_MANY_ACTIONS',
        `副本 ${id} 的动作数 ${list.length} 超过上限 ${MAX_ACTIONS}`,
      );
    }
    const actions = list.map((entry) => {
      if (typeof entry === 'string') {
        const op = defs.get(entry);
        if (!op) {
          throw new SheetError('SHEET_UNKNOWN_REF', `副本 ${id} 引用了未定义步骤：${entry}`);
        }
        return { op, ref: entry, inline: false };
      }
      if (entry && typeof entry === 'object') {
        const norm = normalizeOp(entry);
        if (norm.error) {
          // 内联故障操作保留其原始形态，投递时由引擎定位首个拒因
          return {
            op: entry,
            ref: typeof entry.opId === 'string' ? entry.opId : null,
            inline: true,
            badShape: norm.error,
          };
        }
        return { op: norm.op, ref: norm.op.opId, inline: true };
      }
      throw new SheetError('SHEET_BAD_ACTION', `副本 ${id} 的动作项既非标识也非对象`);
    });
    scripts[id] = actions;
  }

  const totalActions = replicaIds.reduce((n, id) => n + scripts[id].length, 0);
  if (totalActions > MAX_ACTIONS * MAX_REPLICAS) {
    throw new SheetError('SHEET_TOO_MANY_ACTIONS', '全部副本动作总数超限');
  }

  return { replicaIds, defs: [...defs.values()], scripts };
}

export function describeAction(action) {
  const op = action.op;
  if (action.badShape) return `内联故障操作（${action.badShape}）`;
  if (op.type === 'delete') return `撤销 ${op.target}`;
  return `插入 ${op.opId}「${op.title}」 seq=${op.seq} parent=${op.parent ?? '根'}`;
}

export class Drill {
  constructor(id, sheet, options = {}) {
    this.id = id;
    this.sheetText = options.sheetText ?? null;
    this.replicaIds = sheet.replicaIds;
    this.scripts = sheet.scripts; // id -> [{op,ref,inline,badShape?}]
    this.defs = sheet.defs;
    this.tick = 0;
    this.replicas = new Map(sheet.replicaIds.map((rid) => [rid, new Replica(rid)]));
    this.log = []; // {tick, replica, ref, kind, title, status, reason}
    this.finished = false;
    this.createdAt = options.createdAt ?? new Date().toISOString();
  }

  get length() {
    return Math.max(0, ...this.replicaIds.map((id) => this.scripts[id].length));
  }

  // 推进回放。steps 缺省为 1（按步骤），Infinity 表示整段
  play(steps = 1) {
    const events = [];
    const start = this.tick;
    const target = this.finished
      ? this.tick
      : Math.min(this.length, this.tick + (steps === Infinity ? this.length : steps));
    while (this.tick < target) {
      this.tick += 1;
      for (const rid of this.replicaIds) {
        const action = this.scripts[rid][this.tick - 1];
        if (!action) continue; // 该副本本 tick 空闲
        const result = this.replicas.get(rid).deliver(action.op, this.tick);
        const event = {
          tick: this.tick,
          replica: rid,
          ref: action.ref,
          kind: action.badShape ? 'malformed' : action.op.type,
          title: describeAction(action),
          ...result,
        };
        this.log.push(event);
        events.push(event);
      }
    }
    if (this.tick >= this.length) this.finished = true;
    return { advanced: target - start, tick: this.tick, events };
  }

  // 重开后继续接收此前滞留的合法（或故障）投递，直达指定副本
  deliverExtra(rid, rawOp) {
    const replica = this.replicas.get(rid);
    if (!replica) throw new SheetError('UNKNOWN_REPLICA', `未知副本：${rid}`);
    const result = replica.deliver(rawOp);
    const event = {
      tick: null,
      replica: rid,
      ref: typeof rawOp?.opId === 'string' ? rawOp.opId : null,
      kind: rawOp?.type === 'delete' ? 'delete' : 'inline',
      title: '重开后零散投递',
      extra: true,
      ...result,
    };
    this.log.push(event);
    return event;
  }

  seal() {
    const snaps = {};
    for (const replica of this.replicas.values()) snaps[replica.id] = replica.seal();
    return snaps;
  }

  // 重置为 tick 0（重新执行同一脚本，结果须完全一致）
  reset() {
    this.replicas = new Map(this.replicaIds.map((rid) => [rid, new Replica(rid)]));
    this.tick = 0;
    this.log = [];
    this.finished = false;
    return this.state();
  }

  state() {
    const replicas = {};
    for (const [rid, r] of this.replicas) replicas[rid] = r.snapshot();
    const visibleSignatures = this.replicaIds.map(
      (rid) => JSON.stringify(this.replicas.get(rid).visibleIds()),
    );
    return {
      id: this.id,
      tick: this.tick,
      length: this.length,
      finished: this.finished,
      sealed: this.replicaIds.every((rid) => this.replicas.get(rid).sealed),
      replicaIds: this.replicaIds,
      replicas,
      log: this.log,
      converged: new Set(visibleSignatures).size <= 1,
      createdAt: this.createdAt,
    };
  }

  toJSON() {
    return {
      id: this.id,
      sheetText: this.sheetText,
      replicaIds: this.replicaIds,
      scripts: this.serializeScripts(),
      defs: this.defs,
      tick: this.tick,
      log: this.log,
      finished: this.finished,
      createdAt: this.createdAt,
      replicas: this.replicaIds.map((rid) => this.replicas.get(rid).toJSON()),
    };
  }

  serializeScripts() {
    const out = {};
    for (const id of this.replicaIds) {
      out[id] = this.scripts[id].map((a) => ({
        op: a.op,
        ref: a.ref,
        inline: a.inline,
        badShape: a.badShape ?? null,
      }));
    }
    return out;
  }

  static restore(data) {
    const sheet = {
      replicaIds: data.replicaIds,
      defs: data.defs,
      scripts: Object.fromEntries(
        Object.entries(data.scripts).map(([rid, list]) => [
          rid,
          list.map((a) => ({ ...a, badShape: a.badShape ?? undefined })),
        ]),
      ),
    };
    const drill = new Drill(data.id, sheet, {
      sheetText: data.sheetText ?? null,
      createdAt: data.createdAt,
    });
    drill.tick = data.tick;
    drill.log = data.log ?? [];
    drill.finished = !!data.finished;
    drill.replicas = new Map(
      (data.replicas ?? []).map((r) => [r.id, Replica.restore(r)]),
    );
    return drill;
  }
}

// 便于测试：序列化 -> 恢复（等价于刷新/关闭重开）
export function reopen(drill) {
  return Drill.restore(JSON.parse(JSON.stringify(drill.toJSON())));
}

export { fingerprint, REJECT };
