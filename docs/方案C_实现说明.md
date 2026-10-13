---
id: plan-c-impl
title: 方案C 实现说明（本机浏览器通道）
app: invoice-bot
scope: 1000 用户；本期不做高并发优化
status: implemented
related: [plan-b, plan-c]
branch: feat/plan-c-client-agent
updated: 2026-10-13
---

# 方案C · 实现说明

> TL;DR：服务器只下发任务与记录结果；真正的 1688 发送在**用户本机浏览器**里由扩展完成。
> 已实现：配对码 + WS 协议 + 任务下发/回执/中断续跑 + 看板面板 + mock agent 验证（55/55）。
> 断线续跑（含服务重启遗留任务自动对账）已落地，见 §5.1。

## 1 交付物

| 文件 | 角色 |
|---|---|
| `lib/agent-hub.js` | 连接中枢：配对码、WS 注册表、心跳、收发 |
| `server.js`（改动） | `/api/agent/*`、`/ws/agent`、`channel=client` 发送、结果入库、断线续跑编排 |
| `sql/schema.sql` / `db.js` | `agent_task` 表（含 `resume_of`）+ 幂等迁移 |
| `extension/` | Chrome/Edge MV3 扩展（`manifest`/`background`/`content`/`popup`） |
| `dashboard.html`（改动） | 「本机浏览器通道」状态条 + 发送通道选择 + **续跑横幅** |
| `scripts/mock-agent.js` | 无扩展时可验证整条链路的模拟客户端 |
| `docs/方案C_用户自带浏览器.md` | 方案设计（本文件的上一级） |

> 验证脚本 `tmp-e2e-resume.js` / `tmp-ui-resume.js` 按约定以 `tmp-*` 命名（`.gitignore` 已排除，不入库）。

## 2 时序

```
看板              服务器(ORCH)                扩展(本机浏览器)         1688
 │ 生成配对码 ────▶ 存 code→uid (TTL 5min)
 │ 填 code 连接 ───────────────────────────▶ WS /ws/agent?code=xxxx
 │                 校验 code → 绑定 uid ◀──── hello{loggedIn,ua,extVer}
 │                 ready ──────────────────▶
 │ 发送(channel=client) ─▶ 建 agent_task
 │                 下发 send_batch ────────▶ 逐个卖家打开聊天页
 │                                          ─────────────────────▶ 输入+发送
 │                                         ◀─ sent{taskId,loginId,ok}
 │ ◀─ 进度轮询 /api/task    写 send_log
```

断线续跑（不需要新协议，复用 `send_batch`，只是换新 taskId 且只带未完成项）：

```
 │ GET /api/agent/resumable ─▶ {task:{pending:3,failed:0,…}}   （服务重启遗留的 running 任务先对账）
 │ 点「继续发送未完成」─▶ POST /api/agent/resume{taskId,scope}
 │                 建新 agent_task(resume_of=旧id) ─▶ send_batch 只含 3 家
 │                                         ◀─ sent{新taskId,…} ×3
 │ ◀─ 旧任务标记「已作废」，横幅消失
```

## 3 协议（WebSocket）

| 消息 | 方向 | 字段 |
|---|---|---|
| `hello` | 客户端→服务器 | `loggedIn, ua, extVer, platform` |
| `ready` | 服务器→客户端 | `uid, serverTime` |
| `ping` / `pong` | 双向 | `t`（服务器每 20s 心跳，75s 无响应视为离线） |
| `send_batch` | 服务器→客户端 | `taskId, gapMs{min,max}, sellers[]{loginId,sellerLogin,company,messages[]}` |
| `sent` | 客户端→服务器 | `taskId, loginId, ok, error?` |
| `stop` | 服务器→客户端 | `taskId` |
| `login_state` | 客户端→服务器 | `loggedIn`（仅布尔，不上报 Cookie） |
| `log` | 客户端→服务器 | `text`（回显到看板任务日志） |

鉴权：`/ws/agent?code=<6位>`；配对码 5 分钟有效，生成新码会作废旧码，`disconnect` 会吊销。

## 4 数据

| 表 | 关键列 | 说明 |
|---|---|---|
| `agent_task` | `user_id, status, total/done/ok/fail, items(JSON), error, resume_of, started_at, finished_at` | `items` 保留每条 `pending|ok|fail`；`resume_of` 指向被接续的任务（NULL=全新），供断线续跑与审计 |
| `send_log` | 复用 | `channel='client'` 区分本机通道发送；金额/订单号/失败原因照旧 |

任务状态机：`queued → running → done | aborted | failed`。

## 5 关键行为

| 场景 | 行为 |
|---|---|
| 通道未连接就发送 | 直接报错「本机浏览器通道未连接」 |
| 通道离线（浏览器关闭） | 正在跑的任务立即置 `aborted`，未发送项保留为 `pending`，原因入 `error` |
| 用户点停止 | 下发 `stop`，当前卖家发完后结束，状态 `aborted` |
| 长时间无回执 | 超时结束（`卖家数 ×(间隔上限+60s)`，下限 2 分钟），状态 `failed` |
| 看板查看他人数据 | 只读，不能操作本机通道（403） |

## 5.1 断线续跑（已实现）

**核心口径：续跑 = 只补发「未完成项」，已成功的绝不重发**（幂等靠 `items[].status` 过滤，不依赖 taskId）。

| 项 | 实现 |
|---|---|
| 断点数据 | 任务结束/中断时把每条 `ok|fail|pending` 写回 `agent_task.items`（唯一事实来源） |
| 补发范围 | `pending`（未送达）/ `failed`（发送失败）/ `both`，按 loginId 去重 |
| 触发方式 | 看板横幅一键（人工确认），不做无提示自动重发 |
| 重复防护 | 被续跑接续过的旧任务记为「已作废」，不再重复提示（防把已补发的项再发一遍） |
| 服务重启 | 库里仍是 `running` 但内存已无对应任务 → 自动对账置 `aborted`，可续 |
| 失败留痕 | 每次尝试都写一条 `send_log`，重试成功**不覆盖**此前的失败记录 |

接口：

| 接口 | 说明 |
|---|---|
| `GET /api/agent/resumable` | 返回最近一次仍有未完成项的任务：`{task:{id,status,error,total,ok,fail,pending,failed,remaining[]}}`；无则 `{task:null}` |
| `POST /api/agent/resume` | 体 `{taskId?, scope?='pending'}`；省略 `taskId` 取最近可续跑任务；只补发未完成项，新建 `agent_task` 且 `resume_of=来源任务` |
| `GET /api/agent/tasks` | 任务列表，带 `pending` 计数与 `resumeOf` |

看板表现：中断后出现黄色续跑横幅（「还有 N 家未发送 / M 家失败」）→ 通道离线时按钮禁用并提示先配对 → 上线即可一键续跑，续跑后横幅自动消失；可点「忽略」本次不再提示。

## 6 安装与使用

1. 看板 → 看板页 → 点「生成配对码」（需先登录系统）
2. 本机浏览器：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`
3. 扩展里填「服务器地址 + 配对码」→ 连接；再点「打开登录页」登录 1688
4. 看板把发送通道切到「本机浏览器」→ 勾选卖家 → 发送
5. 若中途关掉浏览器：重连扩展后，在看板黄色横幅点「继续发送未完成」即可续跑（已成功的不会重发）

无扩展时可用模拟器验证：`node scripts/mock-agent.js --code <配对码>`

## 7 验证结果

| 项 | 结果 |
|---|---|
| 编排链路 e2e（mock agent） | **31/31 通过**（配对→在线→下发→回执→落库→断线中断→清理） |
| **断线续跑 e2e（`tmp-e2e-resume.js`）** | **55/55 通过**：中断→`resumable`→离线守卫→重连续跑→不重发已成功项→失败重试→服务重启遗留对账→边界口径 |
| 看板只读 UI（Playwright） | **10/10 通过**（面板渲染、通道下拉、配对码弹窗、无 JS 报错） |
| **续跑看板 UI（`tmp-ui-resume.js`）** | **18/18 通过**：横幅出现/文案/离线禁用/上线可点/点击真下发/自动消失/忽略/无 JS 报错 |
| 语法检查 | `server.js` / `db.js` / `lib/agent-hub.js` / 扩展 4 文件 / dashboard 内联脚本 全部通过 |
| 迁移幂等性 | 真实库 `invoice_bot` 重跑建库建表无副作用（数据 12143 单在库，仅补 `resume_of` 列） |

## 8 边界与未实现

| 项 | 说明 |
|---|---|
| 真实 1688 发送 | 扩展 `content.js` 复用 `lib/sender.js` 的选择器（`pre.edit` / `button.send-btn`）；**未在真实 1688 账号上实测**，需实机验证 |
| 续跑为「人工一键」 | 不做无人值守自动重发（避免用户不知情地再次触达商家）；若日后要自动化，可在通道重连事件上挂同样的补发逻辑 |
| 续跑不重算话术 | 续跑时按**当前**订单数据重建消息（不是重放旧文案）；如需严格重放，要把 `messages` 也存进 `items` |
| 常驻页 / 书签脚本 | 本方案设计里的备选通道，本期未实现（仅扩展） |
| Firefox / Safari | 需改编 manifest 或打包，本期仅 Chrome/Edge |
| 高并发 | 本期不做（按 1000 用户、非高并发口径） |
