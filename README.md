# 姿控步骤单多副本演练台

审查员可在页面粘贴包含 **2~4 个副本**、每副本 **最多 40 项**生成/投递动作的姿控步骤单，
按步骤或整段回放，逐项查看各副本的**可见步骤、等待操作、墓碑、首个拒因与已应用记录**。

零运行时依赖（Node 20+ 内置 `node:http` / `node:test` / Web Crypto 风格 `fetch`）。

## 核心语义

每个副本独立维护：`seen`（操作标识→首次指纹）、`nodes`（步骤与墓碑）、
`applied`（已应用）、`waiting`（等待依赖）、`rejected`（拒因，按出现先后排列，列表首项即首个拒因）。

- **稳定操作标识**：每个操作带 `opId`；规范化指纹为其类型与载荷字节的 SHA-256。
- **收敛排序**：同一父步骤下按 `(seq, opId)` 稳定排序，与投递顺序无关。
  两个副本在同一父步骤后离线并发插入、再以相反顺序投递，最终可见序列相同。
- **撤销与墓碑**：`delete` 把目标节点置为不可见墓碑。**先撤销祖先、再收到其下合法子步骤时**，
  祖先保留为不可见墓碑，子孙顶替墓碑在正确位置展开。重复撤销墓碑 → `TARGET_TOMBSTONED`，不新增墓碑。
- **乱序等待**：父项/撤销目标尚未到达时进入等待；依赖齐备后在 fixpoint 中链式收敛，
  每个操作**仅应用一次**。
- **重复投递**：同标识同指纹的重复投递直接忽略，不新增步骤、墓碑或等待项。
- **故障定位（首个拒因，既有投影不变）**：
  - 复用 `opId` 但篡改任一载荷字节 → `REPLAY_CONFLICT`（以派生键留痕，不污染原标识）；
  - 父项形态非法 → `MISSING_PARENT`（形态校验先于序号，故同时越界时定位为缺父）；
  - 父项已被拒绝 → `PARENT_REJECTED`；父项从未出现 → 保持等待（离线滞留），封存时定性为缺父；
  - 序号不在 `0..39` → `SEQ_OUT_OF_RANGE`；
  - 撤销目标已被拒绝 → `TARGET_MISSING`。
- **刷新/关闭重开**：服务端在响应前把全部演练原子落盘（临时文件 + `rename`），
  重启后恢复相同的可见序列、等待操作与已应用记录，并可继续接收此前滞留的合法投递；
  滞留项到达后仅应用一次。**封存（seal）是显式动作**，用于让永缺依赖的等待项定性，与刷新无关。

## 步骤单格式

```json
{
  "replicas": ["R1", "R2"],
  "steps": [
    { "opId": "p", "type": "insert", "parent": null, "seq": 0, "title": "根步骤" },
    { "opId": "x", "type": "insert", "parent": "p", "seq": 1, "title": "通道X" },
    { "opId": "y", "type": "insert", "parent": "p", "seq": 1, "title": "通道Y" },
    { "opId": "del-x", "type": "delete", "target": "x" }
  ],
  "scripts": {
    "R1": ["p", "x", "y"],
    "R2": ["p", "y", "x", { "opId": "bad", "type": "insert", "parent": null, "seq": 99, "title": "越界" }]
  }
}
```

- `scripts.<副本>` 的每一项是一个 tick 的动作；同一 tick 内各副本并发投递。
- 字符串引用 `steps` 定义，重复字符串即重复投递；内联对象可注入故障。

## 本地运行

```bash
npm start                 # http://localhost:8080
HOST_PORT=9090 npm start  # 自定义端口（PORT 环境变量）
```

## 测试与冒烟

```bash
npm run build   # 构建页面到 dist/（node --check 校验前后端语法）
npm test        # 14 个代码测试（引擎 8 + 编排 6）
npm run smoke   # HTTP 冒烟，含“关闭进程-重启恢复-补投滞留操作”
npm run verify  # build + test + smoke，退出码报告结果
```

## Compose

```bash
HOST_PORT=9090 docker compose up --build web      # 页面与 /healthz，宿主机端口可配置
docker compose up --build verify                  # 一次性验收，结束退出并以退出码报告
```

`verify` 的验收对象为：**并发插入相反顺序收敛、祖先撤销后的迟到合法子项、重开恢复**；
依次执行：构建页面 → 代码测试 → 本地端到端冒烟（含进程重启恢复）
→ 对 `web` 的页面与 `/healthz` 做 HTTP 冒烟（`BASE_URL=http://web:8080`）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET | `/` `/app.js` `/app.css` | 页面与静态资源 |
| POST | `/api/drills` | body `{ "sheet": "<JSON 字符串>" }` 创建演练 |
| GET | `/api/drills/:id` | 当前状态（各副本可见/等待/墓碑/拒绝/已应用 + 日志） |
| POST | `/api/drills/:id/play` | `{ "steps": 1 }` 按步骤；`{ "steps": "all" }` 整段 |
| POST | `/api/drills/:id/reset` | 回到 tick 0 |
| POST | `/api/drills/:id/seal` | 封存（滞留等待项定性为最终拒因） |
| POST | `/api/drills/:id/deliver` | `{ "replica": "R1", "op": { ... } }` 重开后零散投递 |
