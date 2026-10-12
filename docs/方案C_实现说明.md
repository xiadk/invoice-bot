---
id: plan-c-impl
title: 方案C 实现说明（本机浏览器通道）
app: invoice-bot
scope: 1000 用户；本期不做高并发优化
status: implemented
related: [plan-b, plan-c]
branch: feat/plan-c-client-agent
---

# 方案C · 实现说明

> TL;DR：服务器只下发任务与记录结果；真正的 1688 发送在**用户本机浏览器**里由扩展完成。
> 已实现：配对码 + WS 协议 + 任务下发/回执/中断续跑 + 看板面板 + mock agent 验证（31/31）。

## 1 交付物

| 文件 | 角色 |
|---|---|
| `lib/agent-hub.js` | 连接中枢：配对码、WS 注册表、心跳、收发 |
| `server.js`（改动） | `/api/agent/*`、`/ws/agent`、`channel=client` 发送、结果入库 |
| `sql/schema.sql` / `db.js` | 新增 `agent_task` 表 + 幂等迁移 |
| `extension/` | Chrome/Edge MV3 扩展（`manifest`/`background`/`content`/`popup`） |
| `dashboard.html`（改动） | 「本机浏览器通道」状态条 + 发送通道选择 |
| `scripts/mock-agent.js` | 无扩展时可验证整条链路的模拟客户端 |
| `docs/方案C_用户自带浏览器.md` | 方案设计（本文件的上一级） |

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
| `agent_task` | `user_id, status, total/done/ok/fail, items(JSON), error, started_at, finished_at` | `items` 保留每条 `pending|ok|fail`，用于断线续跑 |
| `send_log` | 复用 | `channel='client'` 区分本机通道发送；金额/订单号/失败原因照旧 |

任务状态机：`queued → running → done | aborted | failed`。

## 5 关键行为

| 场景 | 行为 |
|---|---|
| 通道未连接就发送 | 直接报错「本机浏览器通道未连接」 |
| 通道离线（浏览器关闭） | 正在跑的任务立即置 `aborted`，原因入 `error` |
| 用户点停止 | 下发 `stop`，当前卖家发完后结束，状态 `aborted` |
| 长时间无回执 | 超时结束（`卖家数 ×(间隔上限+60s)`，下限 2 分钟），状态 `failed` |
| 看板查看他人数据 | 只读，不能操作本机通道（403） |

## 6 安装与使用

1. 看板 → 看板页 → 点「生成配对码」（需先登录系统）
2. 本机浏览器：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`
3. 扩展里填「服务器地址 + 配对码」→ 连接；再点「打开登录页」登录 1688
4. 看板把发送通道切到「本机浏览器」→ 勾选卖家 → 发送

无扩展时可用模拟器验证：`node scripts/mock-agent.js --code <配对码>`

## 7 验证结果

| 项 | 结果 |
|---|---|
| 编排链路 e2e（mock agent） | **31/31 通过**（配对→在线→下发→回执→落库→断线中断→清理） |
| 看板只读 UI（Playwright） | **10/10 通过**（面板渲染、通道下拉、配对码弹窗、无 JS 报错） |
| 语法检查 | `server.js` / `lib/agent-hub.js` / 扩展 4 文件 全部通过 |

## 8 边界与未实现

| 项 | 说明 |
|---|---|
| 真实 1688 发送 | 扩展 `content.js` 复用 `lib/sender.js` 的选择器（`pre.edit` / `button.send-btn`）；**未在真实 1688 账号上实测**，需实机验证 |
| 断线续跑 | `agent_task.items` 已留存每项状态；自动续发 UI 未实现（当前为人工重发） |
| 常驻页 / 书签脚本 | 本方案设计里的备选通道，本期未实现（仅扩展） |
| Firefox / Safari | 需改编 manifest 或打包，本期仅 Chrome/Edge |
| 高并发 | 本期不做（按 1000 用户、非高并发口径） |
