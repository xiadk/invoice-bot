# invoice-bot AI 需求文档（AI 开发指南）

> 本文档供 AI 编程助手以最小 token 消耗理解本项目并执行二次开发。**修改任何代码前，先读完本文档。**
>
> 当前版本已二次开发：取消提交开票申请；数据源改为 MySQL；新增税务局已开票数据与销方名称映射；多用户账号登录（数据按 `user_id` 隔离，超管 `admin`）。
>
> **2026-10-13 架构重大调整（必读）**：① **服务器不再保存 1688 登录态、不再启动服务端浏览器** —— 发送只剩「本机浏览器通道」（方案C）：用户本机 Chrome/Edge 装 `extension/` 扩展，配对码连 `/ws/agent`，服务器只编排任务、扩展在本机浏览器逐家发送并回执；`lib/state-store.js`、`/api/state/*`、`login.js`、`refresh-status.js`、`send-messages.js`、`fetch-invoices.js`、`login_state` 表**已全部删除/废弃**。② 「重新导入数据」由**全量重建**改为**增量去重导入**（按订单号/行哈希，已有跳过、只插新行 + 映射回填 JOIN UPDATE）。历史方案见 `docs/方案B_服务端浏览器池.md`（已废弃）与 `docs/方案调整_登录态入库.md`（已废弃）。
>
> **代码仓库**：https://github.com/xiadk/invoice-bot.git （远程 `origin`，分支 `main`；`data/` 下真实业务数据与 `config.json` 不入库）

---

## 强制规则（每次任务都适用）

1. **文档同步**：修改代码后必须同步更新 `docs/使用说明.md`（用户可见的行为/命令/参数变化）和 `docs/开发者需求文档.md`（架构/接口/数据结构/新坑，对应第 5/6/9/10 节）。只改代码不改文档视为任务未完成。
2. **不引入新依赖/新文件**，除非任务明确要求。（当前已引入：`mysql2` 驱动、`db.js`、`import-to-db.js`、`sql/schema.sql`、`scripts/*.bat`、`extension/`、`lib/agent-hub.js` —— 属"数据库化/本机通道"这些任务的明确产出。）
3. **绝不**把 `config.json` 内容输出到对话/日志/文档（含账号凭据、数据库密码）。
4. **测试纪律**：
   - 涉及发送的改动：先选 1 家测试，确认聊天记录真实送达（看 `pre.edit` 气泡），再交付
   - 涉及 server.js 的改动：必须重启 server 验证（改代码不重启 = 没生效，这是历史踩过的坑）
   - 验证消息发送结果用「消息尾部文本出现在聊天记录」，不要用「编辑器清空」判断（曾误判）
   - 涉及数据库的改动：必须实际连库跑一遍（`node import-to-db.js` + curl `/api/data`），不能只看代码
   - **改测试/导入逻辑必须用隔离库**（`MYSQL_DATABASE=invoice_bot_test` + 端口 8788），**测试公司名绝不能用真实业务公司名**（`purge` 删号会连根拔数据，见开发者文档 §10-25）
5. 删除文件用可恢复方式（回收站），不用 rm。
6. **同一文件的多处修改不要放在一条消息里并行 Edit**（会静默丢失编辑）——逐条串行，或整文件 Write，改完 grep 锚点复核。

## 项目一句话

1688 买家发票催收：1688 订单导出 + 税务局发票导出 → 统一入 MySQL → 看板按「销方名称映射」统计待开票/已开票 → 一键批量发旺旺催收消息。**提交开票申请功能已移除；发送只走用户本机浏览器通道（服务器不保存登录态、不启动浏览器）。**

## 文件地图（全部内容，按需读）

```
invoice-bot/
├── server.js            # 控制台服务器（HTTP API + DB 聚合 + 本机通道发送任务状态机）
├── db.js                # mysql2 连接池 + ensureSchema(建库建表) + 事务封装
├── import-to-db.js      # Excel → MySQL 导入器（解析/增量去重/自动名称匹配/映射回填/导入日志）
├── sql/schema.sql       # 建库建表 DDL：业务表 + app_user/agent_task + 1 视图，全中文注释，幂等
├── scripts/
│   ├── mysql-start.bat  # 启动便携版 MySQL（硬编码 MYSQL_HOME=C:\Users\hspcadmin\WorkBuddy\mysql）
│   └── mysql-stop.bat   # 停止 MySQL
├── lib/browser.js       # Playwright 封装（★服务端已不启动浏览器，launch 仅作 sender 选择器参考保留）
├── lib/auth.js          # scrypt口令 + HMAC签名Cookie会话 + token_version 即时失效
├── lib/tenancy.js       # 多租户目录 data/users/<id>/…；statusFileFor(invoice-status.json 快照路径)
├── lib/agent-hub.js     # ★唯一发送通道：配对码/WS注册表/心跳/收发（isOnline/send）
├── lib/sender.js        # buildMessages(模板渲染，服务器与扩展共用)；sendToSeller 已退役(选择器参考)
├── extension/           # Chrome/Edge MV3 扩展：配对 + 本机发送 + 弹窗监控面板
│   ├── manifest.json    # MV3 清单（无 cookies 权限，v1.1.0）
│   ├── background.js    # WS 客户端/任务执行/STOP_TASK/task_progress 存储
│   ├── content.js       # 在 1688 聊天页逐家发送（键盘模拟）
│   ├── popup.html/js    # 连接面板 + 实时监控面板（进度条/状态点/停止按钮）
│   └── icons/
├── dashboard.html       # 前端单页：看板+名称映射页+系统管理页+配对指引弹窗（纯原生JS，2s轮询/api/task）
├── login.html           # 登录页（只登录不注册）
├── parse-orders.js      # 【遗留】xlsx → orders-parsed.json，看板已不读
├── preview-messages.js  # npm run msg:preview：离线渲染消息（不联网不发送）
├── config.json          # runtime + messages + mysql(连接参数)（env 可覆盖）；buyerInfo 已遗留
└── data/
    ├── 完成订单/*.xlsx      # 1688 订单导出（数据源 → invoice_order）
    ├── 已开票订单/*.xlsx    # 税务局全量发票导出（数据源 → issued_invoice）
    ├── users/<id>/invoice-status.json  # 平台开票状态快照（可选，导入时同步 invoice_state）
    ├── sent-log.json       # 【遗留】已被 send_log 表替代
    └── users/<id>/…        # 各用户数据目录（完成订单/已开票订单/快照）
```

**已删除（2026-10-13）**：`lib/state-store.js`、`login.js`、`refresh-status.js`、`send-messages.js`、`fetch-invoices.js`（需要时从 git 历史恢复）。

**阅读策略**：改哪读哪，不要全量读文件。常见任务入口：
- 改消息内容/格式 → `lib/sender.js` 的 `DEFAULT_MESSAGES` + `config.json` messages 段
- 改看板交互/页面 → `dashboard.html`（单文件，搜索函数名）
- 改接口/聚合查询/任务逻辑 → `server.js`
- 改表结构/注释 → `sql/schema.sql`（改完必须同步 `db.js`/`import-to-db.js` 的字段列表）
- 改导入解析/匹配规则 → `import-to-db.js`
- 改本机发送行为 → `extension/content.js` + `extension/background.js`（聊天页操作与 WS 协议）

## 核心机制速查

**数据流**：`data/完成订单/*.xlsx` + `data/已开票订单/*.xlsx` +（可选）`data/users/<id>/invoice-status.json` →（`import-to-db.js`）→ MySQL `invoice_bot` →（`server.js` SQL 聚合）→ `dashboard.html`。

**数据库（MariaDB 11.4，库 invoice_bot，见 sql/schema.sql）**：

| 表/视图 | 作用 |
|---|---|
| `invoice_order` | 1688 订单，主键 order_no，含 `invoice_state(none/applying/issued)` |
| `issued_invoice` | 税务局发票**明细行**，`seller_name`→`seller_company` 靠映射，`row_hash` 去重 |
| `seller_name_mapping` | 销方名称↔1688商家 映射（auto/manual/ignored；`is_ignored=1`=确认无对应商家已忽略，可在名称映射页恢复），人工维护成果，导入不覆盖、也不复活已忽略项 |
| `send_log` | 催收发送记录，**一行=一次发送尝试**（`result` 区分 ok/fail）。催收次数=`SUM(result='ok')`（失败不计）；最近催收时间=`MAX(CASE WHEN result='ok' THEN sent_at END)` |
| `import_log` | 导入日志（`skipped` = 去重跳过的已有行数） |
| `app_user` | 账号表（username=公司全称/role/抬头三列/token_version/status） |
| `agent_task` | 本机通道发送任务：`items` JSON 逐条 `pending\|ok\|fail` + `resume_of`，断线续跑靠它 |
| `v_unmatched_seller_name` | 待人工比对的销方名称（LEFT JOIN 派生，已排除「已映射」与「已忽略」） |
| ~~`login_state`~~ | **已废弃（2026-10-13）**：服务器不再保存登录态，DDL 已注释、不再建表 |

**导入策略：增量去重（2026-10-13 起）**。不再 DELETE 重插：订单按 `order_no` 查库去重、发票按 `row_hash` 去重，**只插新行**（`inserted` vs `skippedExisting` 分别计数）；导完做**映射回填** `UPDATE issued_invoice i JOIN seller_name_mapping m ...`（后建的映射要作用到老行）。**删文件不会删数据**（只增不删）；`seller_name_mapping` 不删、`state_source='manual'` 不覆盖。

**自动匹配**（`import-to-db.js matchSeller`，按序）：exact → login → contains（较短方≥4字且占比≥50%，标记待复核）→ login包含 → remark线索。匹配不上的不写占位行，由视图暴露给「名称映射」页。

**看板聚合口径**（`server.js loadCompanies`，公司级；会员名级由 `loadSellers` 产出后在子树里）：
- **看板一行 = 一家公司**（`seller_company` 分组）；会员名（1688 店铺）在 `companies[].members[]` 子树，各自带订单/催收按钮
- 会员名行：`COALESCE(NULLIF(seller_login,''), seller_company)` 分组；订单额 = SUM(pay_amount)
- 已开票额：`issued_invoice` 按映射后 `seller_company` 汇总（张数 = COUNT(DISTINCT e_invoice_no/invoice_no/row_hash)）；同公司多会员名时发票额只挂「主行」（映射表登记的会员名，否则订单最多），公司级求和不会重复
- **待开票额 = max(订单额 − 已开票额, 0)**，公司级按公司总额重算，倒序排列
- 催收次数 / 最近催收时间：`send_log` 按 `seller_login` 聚合，**只计成功**（`result='ok'`；失败尝试不计入次数、也不作最近时间）；公司行 = 求和 / MAX
- 订单级人工确认：`invoice_order.state_source='manual'` 表示商家线下已开票；`/api/order-state` 支持单订单 confirm/cancel 与整会员名 confirm-all/cancel-all，**快照同步与重新导入都不得覆盖 manual**
- 会员名行额外返回 `manualIssuedAmount`（人工确认订单的实付款合计），仅作展示，**不计入**税务局已开票金额
- **催收消息按会员名级**：`{amount}`=该会员名待开票金额，`{orderId}`=该会员名除已开票外的全部订单号（`doClientSend` 里 `invoice_state !== 'issued'` 过滤）
- 注意：**订单级 invoice_state 与发票级已开票金额是两套口径，不要混算**（人工确认只改订单状态计数，不动金额）
- **分页（前端切片）**：看板公司表与映射页三张表支持 10/20/50/100 条/页（`PAGER` 状态，筛选/搜索后回第 1 页）；统计卡始终按全量计算；「**全选当前页**」只勾选当前分页公司的可催收会员名（2026-10-12 起不再跨页全选）
- **看板筛选（2026-10-12 二次改版，全部可组合）**：下拉「催收状态」= **已催收**（默认，有成功催收记录 `sendCount>0`）/ 最近 7/15/30/90 天**无成功催收记录**（`lastSentAt` 为空或距今 ≥ N 天）；下拉「开票状态」= 已开票（待开票金额=0）/ 未开票（>0）；搜索匹配公司名 ∪ 登录ID。「未催收（从未）」标签与「不限」选项已按需求移除
- **看板排序（2026-10-12 改版）**：最近催收时间倒序（无催收沉底）→ 催收时间相同按待开票金额倒序（前端 `visibleCompanies()` 重排）
- **历史催收记录**：`send_log` 的 `amount`/`order_nos`/`error`（发送当时的待开票金额、订单号快照，「；」分隔；`error`=失败原因摘要，仅 fail 行、取首行截断 250 字）；点「催收次数」调 `GET /api/collect-history?loginId=|company=` 弹窗查看；2026-10-12 前的老记录无快照、显示「—」
- **销方名称忽略**：映射页「忽略」= 确认无对应 1688 商家 → `is_ignored=1`、从待比对列表移除、`autoMapSellers` 跳过、`issued_invoice.seller_company` 清空；「已忽略」区可恢复；`/api/data.ignoredNameCount` 供统计卡展示

**发送流程（只走本机浏览器通道，2026-10-13 起）**：
1. 看板 `doSend(ids)` → `POST /api/send {loginIds}`；服务器校验 `agentHub.isOnline(tenantId)`（扩展没连上直接报错）+ 无任务在跑
2. `server.js doClientSend`：建 `agent_task`（items 逐条 pending）+ `CLIENT_TASKS` ctx → `agentHub.send` 下发 `send_batch` → `pushClientProgress` 推首帧
3. `extension/background.js` 收 `send_batch` → 开工作标签页 → `content.js` 在 1688 聊天页逐家发送（选择器与等待逻辑见下）→ 每完成一家回 `sent`
4. `server.js onAgentSent`：更新 items 状态 + 写 `send_log`（ok/fail + amount/order_nos/error 快照）→ 再 `pushClientProgress`
5. `finishClientTask` 收尾（done/aborted/failed）→ 推最终进度；断线时服务器把 running 任务标记中断，看板出「继续发送未完成」横幅 → `/api/agent/resume` 只补 pending/failed

**聊天页操作要点**（`extension/content.js`，与已退役的 `lib/sender.js#sendToSeller` 同源，勿轻改）：
1. 开聊天页 `def_cbu_web_im/index.html?touid=cnalichn{loginId}` → **轮询**等 iframe `def_cbu_web_im_core` 内 `pre.edit[contenteditable=true]`（找到后 1.6s 复确认，**每次操作重新 getFrame，iframe 会重建**）
2. ensureContact：空状态文案（"您尚未选择联系人"）消失判定（轮询）；未选中点左侧会话列表；**不确定时不拦截**
3. sendMessage：清草稿(Ctrl+A+Delete) → `insertText`（**绝不能用 type()，\n 会逐行发送**）→ 轮询验证编辑器有内容 → 点 `button.send-btn` → 轮询验证消息尾部30字出现在聊天记录
4. 消息之间随机停 1.2~2.5s（仅非最后一条）

**性能与限流**：等待一律「轮询到条件满足即继续」，不固定盲等（单家发送动作约 10~15s）。家与家的 `sendGapMinSec/MaxSec`（默认 15~30s）是**防限流主开关**，可在看板设置页调；总时长 ≈ 家数 ×（间隔均值 + 单家约 15s）。

**消息结构**（buildMessages）：3 条 = 模板({amount}/{companyName}/{taxNo}/{email} 变量) + 订单清单(单行「；」分隔，>450字分块) + 提醒。模板在 config.json messages 段。

**mtop 调用**：只能页面内 `window.lib.mtop.request`（纯 Node 报 ILLEGAL_ACCESS）。发票网关 `mtop.1688.kingsuns.invoice.dataline.service`。**批量申请 `batchApplyInvoice` 已停用**；**订单列表 API 有限流，全量数据一律走 xlsx 导出**；平台开票状态快照由用户手动放置 `invoice-status.json`（`refresh-status.js` 已删）。

## 硬约束（违反=功能损坏）

- 订单清单消息必须单行「；」分隔（平台按行拆消息）
- seller 对象跨函数传递必须含 `loginId`（曾漏传导致 touid=undefined，排查三天）
- 动作间保持拟人随机间隔；发送验证「消息出现在聊天记录」而非「编辑器清空」
- 发送等待一律轮询、不固定盲等；`getFrame/getEditor` 必须容错（iframe 重建会抛 detached）
- 登录态失效（跳回 login.1688.com）→ 快速抛错、中止整批且**不写 send_log**（环境问题不污染统计）
- server.js 改完必须重启进程才生效
- `issued_invoice` 只能导「信息汇总表」sheet，导「发票基础信息」会重复计数
- `db.js` 必须保持 `dateStrings:true` + `decimalNumbers:true`（否则时区漂移/字符串比较出错）
- 库名用 `db.safeDbName()` 白名单校验后再拼接（无法参数化）
- Excel 日期用 `XLSX.SSF.parse_date_code()` 转本地时间，不要用 `(n-25569)*86400*1000`
- `/api/apply` 必须继续返回 410 或保持不存在（需求要求取消提交申请）
- **发送记录只有一份真相**：`send_log` 表（一行=一次发送）。看板与扩展回执都写这张表，「已催收」判定统一读它；不要复活 `data/sent-log.json`（旧 JSON 已由 `migrateLegacySentLog()` 在表空时自动迁入一次）
- **服务器不保存 1688 登录态、不启动浏览器**（2026-10-13 架构红线）：不要再新增 `login_state`/`/api/state/*`/`lib/live-browser.js` 之类「登录态过服务器」的代码；发送只能走 `lib/agent-hub.js` + `extension/`
- **老库结构升级**：新增列/索引要同时改 `sql/schema.sql` 和 `db.js migrate()`（information_schema 判断后 ALTER，幂等）；`q()` 已返回行数组，**不要再解构一层**（`const [rows] = await q()` 是坑，见开发者文档 §10-19）
- **人工确认防覆盖**：`applyInvoiceStatus` 带 `state_source <> 'manual'`；取消确认按 `invoice-status.json` 回推平台状态
- **增量导入只插不删**：`importOrders/importInvoices` 严禁再加 `DELETE FROM`；去重在代码里查库集合过滤（`invoice_order` 无 order_no 唯一键），并在 `import_log` 区分 `inserted/skippedExisting`

## 数据库环境（本机现状）

- 便携版 MariaDB 11.4.13：`C:\Users\hspcadmin\WorkBuddy\mysql`（`bin/`、`my.ini`、`data/`）
- 启动：`scripts\mysql-start.bat`（幂等，已在跑会跳过）；停止：`scripts\mysql-stop.bat`
- 客户端：`C:\Users\hspcadmin\WorkBuddy\mysql\bin\mariadb.exe -h127.0.0.1 -uroot -pinvoice123 invoice_bot`
- 换机器时要改 `scripts/*.bat` 里的 `MYSQL_HOME` 和 `config.json` 的 mysql 段

## 新电脑部署（协助用户时的操作依据）

完整用户版步骤在 `docs/使用说明.md`「新电脑部署指南」。AI 协助部署/排查时的要点：

1. **裸机顺序**：Node.js LTS → `npm config set registry https://registry.npmmirror.com` → **装 MySQL 便携版并初始化**（见下）→ 复制项目（带 data/两个数据文件夹 + config.json + `extension/`，**不带 node_modules**）→ `npm install` → `set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` + `npx playwright install chromium`（同窗口连续执行）→ 改 `scripts/*.bat` 的 MYSQL_HOME → `node import-to-db.js` → `node server.js` → 在自己浏览器装扩展配对（见下）
2. **MySQL 便携版安装**：下载 `https://mirrors.tuna.tsinghua.edu.cn/mariadb/mariadb-11.4.13/winx64-packages/mariadb-11.4.13-winx64.zip` → 解压到无中文路径 → 写 `my.ini`（basedir/datadir/port/utf8mb4）→ `bin\mysql_install_db.exe --datadir=... --password=invoice123 --port=3306` → `bin\mysqld.exe --defaults-file=...` 启动
3. **发送通道配对（部署必需，只做一次）**：用户本机 Chrome/Edge 打开 1688 并登录 → `chrome://extensions` 开开发者模式 → 加载已解压的扩展程序选 `extension/` → 看板「配对指引」生成配对码 → 填进扩展点「连接」→ 状态条变绿。**服务器不保存登录态，泄库也拿不到 1688 账号**
4. **常见故障对照**：
   - `npm install` 卡住 → 镜像没设置或没生效（`npm config get registry` 核对）
   - `node -v` 找不到命令 → PATH 问题，重装 Node 勾选 Add to PATH
   - 看板 /api/data 报 `ECONNREFUSED 127.0.0.1:3306` → MySQL 没启动，跑 `scripts\mysql-start.bat`
   - `Access denied for user 'root'` → 初始化时的 `--password` 与 config.json 里不一致
   - 看板卡片全是 0 / 无卖家 → 没跑 `node import-to-db.js`，或 `data/完成订单` 是空的
   - 发送报「本机浏览器通道未连接」→ 扩展没连上/掉线：重新生成配对码连上，确认本机浏览器已登录 1688
   - chromium 下载慢/失败 → PLAYWRIGHT_DOWNLOAD_HOST 未设置或换了命令行窗口（set 只对当前窗口生效）
   - 控制台打不开 → 杀软/防火墙拦 Node 或 8787 端口
5. **迁移红线**：config.json 含账号凭据与数据库密码，指导用户传输时必须提醒用 U 盘等安全方式，不得让用户把内容粘贴到任何在线渠道
6. **部署验收**：必须让用户选一家小额卖家实测催收（消息真实送达+已读）再放批量，不要只看页面能打开就算通过
7. **多机约束**：同一 1688 账号不可两台机器同时登录/发送（互踢登录态+风控），部署新机时提醒停掉旧机

## 二次开发流程

1. 读本文档「文件地图」定位目标文件，Read 目标区域（不全量读大文件）
2. 修改前确认与「核心机制速查」「硬约束」无冲突
3. 实现 + `node --check <file>` 语法校验
4. 按测试纪律验证（发送类：1 家实测+聊天记录确认；server 类：重启+curl API；数据库类：实际导入+查库核对；导入/测试逻辑：隔离库 + 假公司名）
5. **同步更新三处**：代码注释（如有）、`docs/使用说明.md`、`docs/开发者需求文档.md` 对应章节（表结构/接口/踩坑）
6. 汇报时说明：改了什么文件、验证结果、更新了哪份文档的哪一节
