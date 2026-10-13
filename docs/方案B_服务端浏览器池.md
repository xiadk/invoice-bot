---
id: plan-b
title: 方案B·服务端浏览器池
app: invoice-bot
scope: 1000 用户；单机或小集群；本期不做高并发优化
status: draft
related: [plan-c]
---

# 方案B · 服务端浏览器池

> TL;DR：浏览器跑在服务器，用户用任意现代浏览器开网页；发送任务进队列，由固定槽位的 Worker 池消费。本期单机即可支撑 1000 用户。

## 0 约定与缩写

| 缩写 | 含义 |
|---|---|
| U | 用户（租户） |
| T | 一次发送任务（某 U 对一批卖家） |
| W | 发送 Worker（进程） |
| B | 服务器端 Playwright 浏览器（无头 Chromium） |
| SS | 登录态文件（Playwright storageState） |
| Q | 任务队列 |
| LB | 反向代理 / 负载均衡 |

原则：B 在服务器；U 侧只需现代浏览器；单账号串行；全局槽位上限。无头开关自动判定（Linux 无 `DISPLAY`→无头）。

## 1 目标

- U 用「账号+密码」登录系统；看板/映射数据按 U 隔离。
- U 在任意现代浏览器触发发送；实际发送由服务器 B 执行。
- U 无 1688 登录态时，在**本机浏览器登录后由扩展上传**登录态（加密入库），后续复用。
- 超管可管理账号、并只读查看任一 U 的看板与映射。

## 2 拓扑

```
U浏览器(任意) ──HTTPS/WSS──▶ LB(Nginx) ──▶ Web API ──▶ MariaDB
                                            │
                                            └─▶ Q ─▶ W池(每槽1个B) ─▶ 1688 聊天
```

## 3 组件职责

| 组件 | 职责 | 技术/文件 |
|---|---|---|
| Web API | 认证、看板/映射/管理接口、派发 T、登录态接口 | `server.js` |
| 认证会话 | 密码哈希 + 签名 Cookie 会话 + 失效 | `lib/auth.js` |
| 多租户 | 解析租户、每 U 数据目录与 SS 路径 | `lib/tenancy.js` |
| B 启动 | 启动浏览器、恢复 SS、拟人间隔 | `lib/browser.js` |
| 发送引擎 | 打开聊天、发消息、检测登录失效 | `lib/sender.js` |
| 登录态 | 加密入库（本地登录上传）/ 服务端发送时取用 | `lib/state-store.js`、`login_state` 表 |
| 队列/Worker | 排队、限流、执行 T | `worker.js`（新增）|
| 数据层 | 连接池 + 幂等迁移 | `db.js`、`sql/schema.sql` |
| 前端 | 登录页、看板、映射、系统管理 | `login.html`、`dashboard.html`、`compat.html`（新增）|

## 4 关键流程

### 4.1 U 登录系统
1. `POST /api/auth/login` {username,password} → 校验 → 下发签名 Cookie(HttpOnly)。
2. 未登录/失效访问受保护接口 → 401；前端跳登录页。
3. 会话失效：`token_version` 变更（改密/禁用/删除）即时作废。

### 4.2 1688 登录态（无 SS 时）
1. U 点「登录 1688」→ `POST /api/state/upload-token` 取一次性上传码。
2. U 在**自己电脑的浏览器**登录 1688（扩展「上传登录态」）。
3. `POST /api/state/upload` → AES-256-GCM 加密 → UPSERT `login_state`（**服务器不承载登录画面**）。
4. 若 U 也可装扩展，则 U 点「登录 1688」不需要任何投屏。

### 4.3 发送 T
1. U 勾选卖家 → `POST /api/send` → 建 T(单 U 仅 1 个在跑) → 入 Q。
2. W 取 T → 打开 B（加载该 U 的 SS）→ 逐卖家：取待开票订单 → 组装话术 → `sendToSeller` → 记录 `send_log`。
3. 卖家间隔 15~30s 拟人；登录失效 → 中止整批并提示重新登录。
4. 进度经 `/api/task` 轮询回前端；U 可随时停止。

## 5 并发与限流（本期参数）

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxSlots` 全局槽位 | 8 | 同时运行的 B 数；单机上限 |
| 单 U 并发 T | 1 | 复用 `taskState.running` |
| 卖家间隔 | 15~30s | 拟人，防限流 |
| B 单账号上限 | 1 | 同账号不并行 |
| 登录态失效 | 发送即知 | 发送时被跳登录页 → 标记 `expired` 并提示重新上传 |
| SS 复用 | 长期 | 失效自动提示重登 |

## 6 数据隔离

| 表 | 隔离键 | 说明 |
|---|---|---|
| `app_user` | `id` | 账号、角色、抬头、状态 |
| `invoice_order` | `user_id` | 订单 |
| `issued_invoice` | `user_id` | 已开票 |
| `seller_name_mapping` | `user_id` | 名称映射 |
| `send_log` | `user_id` | 催收记录 |
| `import_log` | `user_id` | 导入记录 |
| SS 文件 | 路径 | `data/users/<uid>/` |

超管跨 U：`?tenant=<uid>`，服务端强制只读。

## 7 部署（单机版）

| 服务 | 镜像/来源 | 端口 | 建议资源 |
|---|---|---|---|
| app(API+Worker) | `Dockerfile`(Playwright 基础镜像) | 8787 | 4C8G |
| MariaDB | `mariadb:11` | 3306 | 2C4G |
| LB | `nginx` | 443/80 | 0.5C |

- 数据卷：`mysql-data`、`app-data`(SS/导入文件)。
- 环境变量：`DB_*`、`SESSION_SECRET`、`HEADLESS=1`、`MAX_SLOTS`。
- 首次启动自动建表 + 建 `admin/admin`。

## 8 容量估算（1000 U，非高并发口径）

| 项 | 公式 | 值 |
|---|---|---|
| 峰值同时在发 U | 1000 × 1%/min ÷ 摊销 | ≈ 8~20 |
| 并存 B 数 | ≤ `maxSlots` | 8（可调 20）|
| B 内存 | 8 × ~350MB | ≈ 3GB |
| 看板并发 | 1000 登录，轮询 | Node 单进程可承 |
| DB 连接 | 池 20 | 足够 |

结论：单机 4C8G + 2C4G DB 可支撑；扩容只需调大 `maxSlots` 或加 W 节点。

## 9 关键文件

| 文件 | 作用 |
|---|---|
| `server.js` | API/认证/管理/登录态接口 |
| `worker.js`(新增) | 队列消费 + 发送 |
| `lib/browser.js` | B 启动 + 无头自动判定 |
| `lib/sender.js` | 发送引擎 |
| `lib/state-store.js` | 登录态加密入库（取代原投屏登录） |
| `lib/auth.js` / `lib/tenancy.js` | 会话 / 租户 |
| `db.js` / `sql/schema.sql` | 数据层 |
| `login.html` / `dashboard.html` / `compat.html` | 前端 |

## 10 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 服务器无显示器 | B 启动失败 | 自动无头 + `--no-sandbox` 等容器参数 |
| 1688 风控/限流 | 发送失败 | 拟人间隔 + 退避 + 失败留痕 |
| SS 失效 | 批量中止 | 检测跳登录页 → 中止 + 引导重登 |
| B 崩溃/卡死 | 任务卡住 | 单步超时 + 看门狗 + 重试 |
| 单机故障 | 全站不可用 | 数据卷备份；后续再上多机 |

## 11 验收

- [ ] U 登录/隔离：他人数据不可见、不可写。
- [ ] 超管：建号/重置/禁用/删除 + 按用户名查数据。
- [ ] 无登录态时，用一次性上传码从本机浏览器上传成功（入库为密文）。
- [ ] 发送成功写 `send_log`（金额/订单号/失败原因）。
- [ ] 登录失效中止整批并提示。
- [ ] 不支持浏览器访问 → 显示 `compat.html` 提示页。
