# invoice-bot AI 需求文档（AI 开发指南）

> 本文档供 AI 编程助手以最小 token 消耗理解本项目并执行二次开发。**修改任何代码前，先读完本文档。**
>
> 当前版本已二次开发：取消提交开票申请；数据源改为 MySQL；新增税务局已开票数据与销方名称映射。
>
> **代码仓库**：https://github.com/xiadk/invoice-bot.git （远程 `origin`，分支 `main`；`data/` 下真实业务数据与 `config.json` 不入库）

---

## 强制规则（每次任务都适用）

1. **文档同步**：修改代码后必须同步更新 `docs/使用说明.md`（用户可见的行为/命令/参数变化）和 `docs/开发者需求文档.md`（架构/接口/数据结构/新坑，对应第 5/6/9/10 节）。只改代码不改文档视为任务未完成。
2. **不引入新依赖/新文件**，除非任务明确要求。（当前已引入：`mysql2` 驱动、`db.js`、`import-to-db.js`、`sql/schema.sql`、`scripts/*.bat` —— 属"数据库化"这次任务的明确产出。）
3. **绝不**把 `config.json`、`data/state-1688.json` 内容输出到对话/日志/文档（含账号凭据、数据库密码）。
4. **测试纪律**：
   - 涉及发送的改动：先 `--limit=1` 或选 1 家测试，确认聊天记录真实送达（看 `pre.edit` 气泡），再交付
   - 涉及 server.js 的改动：必须重启 server 验证（改代码不重启 = 没生效，这是历史踩过的坑）
   - 验证消息发送结果用「消息尾部文本出现在聊天记录」，不要用「编辑器清空」判断（曾误判）
   - 涉及数据库的改动：必须实际连库跑一遍（`node import-to-db.js` + curl `/api/data`），不能只看代码
5. 删除文件用可恢复方式（回收站），不用 rm。

## 项目一句话

1688 买家发票催收：1688 订单导出 + 税务局发票导出 → 统一入 MySQL → 看板按「销方名称映射」统计待开票/已开票 → 一键批量发旺旺催收消息（Playwright 操作聊天页）。**提交开票申请功能已移除。**

## 文件地图（全部内容，按需读）

```
invoice-bot/
├── server.js            # 控制台服务器（HTTP API + DB 聚合 + 发送任务状态机）~430行
├── db.js                # mysql2 连接池 + ensureSchema(建库建表) + 事务封装
├── import-to-db.js      # Excel → MySQL 导入器（解析/去重/自动名称匹配/导入日志）
├── sql/schema.sql       # 建库建表 DDL：5 表 + 1 视图，全中文注释，幂等
├── scripts/
│   ├── mysql-start.bat  # 启动便携版 MySQL（硬编码 MYSQL_HOME=C:\Users\hspcadmin\WorkBuddy\mysql）
│   └── mysql-stop.bat   # 停止 MySQL
├── lib/browser.js       # Playwright封装：launch(storageState复用)/humanPause/waitHuman
├── lib/sender.js        # 唯一发送实现：buildMessages(模板) + sendToSeller(聊天操作) ~210行
├── dashboard.html       # 前端单页：看板+名称映射页+设置页（纯原生JS，2s轮询/api/task）
├── login.js             # 扫码登录 → data/state-1688.json
├── refresh-status.js    # mtop → data/invoice-status.json + 直接同步 invoice_order.invoice_state
├── send-messages.js     # CLI发送入口（复用lib/sender，发送记录写 send_log 表）
├── fetch-invoices.js    # 发票全量 → CSV
├── parse-orders.js      # 【遗留】xlsx → orders-parsed.json，看板已不读
├── config.json          # buyerInfo + runtime + messages + mysql(连接参数)
└── data/
    ├── 完成订单/*.xlsx      # 1688 订单导出（数据源 → invoice_order）
    ├── 已开票订单/*.xlsx    # 税务局全量发票导出（数据源 → issued_invoice）
    ├── invoice-status.json # 平台侧已申请/已开票订单号（可选，导入时写 invoice_state）
    ├── sent-log.json       # 【遗留】已被 send_log 表替代
    └── state-1688.json     # 登录态（勿读勿输出）
```

**阅读策略**：改哪读哪，不要全量读文件。常见任务入口：
- 改消息内容/格式 → `lib/sender.js` 的 `DEFAULT_MESSAGES` + `config.json` messages 段
- 改看板交互/页面 → `dashboard.html`（单文件，搜索函数名）
- 改接口/聚合查询/任务逻辑 → `server.js`
- 改表结构/注释 → `sql/schema.sql`（改完必须同步 `db.js`/`import-to-db.js` 的字段列表）
- 改导入解析/匹配规则 → `import-to-db.js`
- 改发送流程 → `lib/sender.js` 的 `sendToSeller`

## 核心机制速查

**数据流**：`data/完成订单/*.xlsx` + `data/已开票订单/*.xlsx` +（可选）`invoice-status.json` →（`import-to-db.js`）→ MySQL `invoice_bot` →（`server.js` SQL 聚合）→ `dashboard.html`。

**数据库（MariaDB 11.4，库 invoice_bot，见 sql/schema.sql）**：

| 表/视图 | 作用 |
|---|---|
| `invoice_order` | 1688 订单，主键 order_no，含 `invoice_state(none/applying/issued)` |
| `issued_invoice` | 税务局发票**明细行**，`seller_name`→`seller_company` 靠映射，`row_hash` 去重 |
| `seller_name_mapping` | 销方名称↔1688商家 映射（auto/manual/ignored；`is_ignored=1`=确认无对应商家已忽略，可在名称映射页恢复），人工维护成果，导入不覆盖、也不复活已忽略项 |
| `send_log` | 催收发送记录，**一行=一次发送尝试**（`result` 区分 ok/fail）。催收次数=`SUM(result='ok')`（失败不计）；最近催收时间=`MAX(CASE WHEN result='ok' THEN sent_at END)` |
| `import_log` | 导入日志 |
| `v_unmatched_seller_name` | 待人工比对的销方名称（LEFT JOIN 派生，已排除「已映射」与「已忽略」） |

**导入策略：全量重建**。两张明细表 `DELETE` 后重插（文件夹里的 Excel 是唯一真相）；`invoice_order.invoice_state` 先读内存再回填；`seller_name_mapping` 不删。

**自动匹配**（`import-to-db.js matchSeller`，按序）：exact → login → contains（较短方≥4字且占比≥50%，标记待复核）→ login包含 → remark线索。匹配不上的不写占位行，由视图暴露给「名称映射」页。

**看板聚合口径**（`server.js loadCompanies`，公司级；会员名级由 `loadSellers` 产出后在子树里）：
- **看板一行 = 一家公司**（`seller_company` 分组）；会员名（1688 店铺）在 `companies[].members[]` 子树，各自带订单/催收按钮
- 会员名行：`COALESCE(NULLIF(seller_login,''), seller_company)` 分组；订单额 = SUM(pay_amount)
- 已开票额：`issued_invoice` 按映射后 `seller_company` 汇总（张数 = COUNT(DISTINCT e_invoice_no/invoice_no/row_hash)）；同公司多会员名时发票额只挂「主行」（映射表登记的会员名，否则订单最多），公司级求和不会重复
- **待开票额 = max(订单额 − 已开票额, 0)**，公司级按公司总额重算，倒序排列
- 催收次数 / 最近催收时间：`send_log` 按 `seller_login` 聚合，**只计成功**（`result='ok'`；失败尝试不计入次数、也不作最近时间）；公司行 = 求和 / MAX
- 订单级人工确认：`invoice_order.state_source='manual'` 表示商家线下已开票；`/api/order-state` 支持单订单 confirm/cancel 与整会员名 confirm-all/cancel-all，**平台刷新与重新导入都不得覆盖 manual**
- 会员名行额外返回 `manualIssuedAmount`（人工确认订单的实付款合计），仅作展示，**不计入**税务局已开票金额
- **催收消息按会员名级**：`{amount}`=该会员名待开票金额，`{orderId}`=该会员名除已开票外的全部订单号（`doSend` 里 `invoice_state !== 'issued'` 过滤）
- 注意：**订单级 invoice_state 与发票级已开票金额是两套口径，不要混算**（人工确认只改订单状态计数，不动金额）
- **分页（前端切片）**：看板公司表与映射页三张表支持 10/20/50/100 条/页（`PAGER` 状态，筛选/搜索后回第 1 页）；统计卡始终按全量计算；`全选筛选结果` 跨所有分页
- **销方名称忽略**：映射页「忽略」= 确认无对应 1688 商家 → `is_ignored=1`、从待比对列表移除、`autoMapSellers` 跳过、`issued_invoice.seller_company` 清空；「已忽略」区可恢复；`/api/data.ignoredNameCount` 供统计卡展示

**发送流程**（lib/sender.js sendToSeller，勿轻改）：
1. 开聊天页 `def_cbu_web_im/index.html?touid=cnalichn{loginId}` + bringToFront
2. 等 iframe `def_cbu_web_im_core` 内 `pre.edit[contenteditable=true]` 稳定（**每次操作重新 getFrame，iframe 会重建**）
3. ensureContact：空状态文案（"您尚未选择联系人"）消失判定；未选中点左侧会话列表；**不确定时不拦截**
4. sendMessage：清草稿(Ctrl+A+Delete) → `keyboard.insertText`（**绝不能用 type()，\n 会逐行发送**）→ 验证编辑器有内容 → 点 `button.send-btn` → 验证消息尾部30字出现在聊天记录

**消息结构**（buildMessages）：3 条 = 模板({amount}/{companyName}/{taxNo}/{email} 变量) + 订单清单(单行「；」分隔，>450字分块) + 提醒。模板在 config.json messages 段。

**mtop 调用**：只能页面内 `window.lib.mtop.request`（纯 Node 报 ILLEGAL_ACCESS）。发票网关 `mtop.1688.kingsuns.invoice.dataline.service`。**批量申请 `batchApplyInvoice` 已停用**。**订单列表 API 有限流，全量数据一律走 xlsx 导出**。

## 硬约束（违反=功能损坏）

- 订单清单消息必须单行「；」分隔（平台按行拆消息）
- seller 对象跨函数传递必须含 `loginId`（曾漏传导致 touid=undefined，排查三天）
- Playwright 1.64 无 `page.waitForTimeout`，用本地 `sleep(ms)`
- 动作间保持拟人随机间隔；发送验证「消息出现在聊天记录」而非「编辑器清空」
- server.js 改完必须重启进程才生效
- `issued_invoice` 只能导「信息汇总表」sheet，导「发票基础信息」会重复计数
- `db.js` 必须保持 `dateStrings:true` + `decimalNumbers:true`（否则时区漂移/字符串比较出错）
- 库名用 `db.safeDbName()` 白名单校验后再拼接（无法参数化）
- Excel 日期用 `XLSX.SSF.parse_date_code()` 转本地时间，不要用 `(n-25569)*86400*1000`
- `/api/apply` 必须继续返回 410 或保持不存在（需求要求取消提交申请）
- **发送记录只有一份真相**：`send_log` 表（一行=一次发送）。任何发送入口（server.js / send-messages.js）都必须写这张表，且"已催收"判定统一读它；不要复活 `data/sent-log.json`（旧 JSON 已由 `migrateLegacySentLog()` 在表空时自动迁入一次）
- **老库结构升级**：新增列/索引要同时改 `sql/schema.sql` 和 `db.js migrate()`（information_schema 判断后 ALTER，幂等）
- **人工确认防覆盖**：`applyInvoiceStatus` 带 `state_source <> 'manual'`；`importOrders` 回填 state 四件套；取消确认按 `invoice-status.json` 回推平台状态
- `send-messages.js` 与 `refresh-status.js` 都依赖数据库连接，改动时注意 `db.closePool()`（否则进程不退出）和 DB 未启动时的友好报错

## 数据库环境（本机现状）

- 便携版 MariaDB 11.4.13：`C:\Users\hspcadmin\WorkBuddy\mysql`（`bin/`、`my.ini`、`data/`）
- 启动：`scripts\mysql-start.bat`（幂等，已在跑会跳过）；停止：`scripts\mysql-stop.bat`
- 客户端：`C:\Users\hspcadmin\WorkBuddy\mysql\bin\mariadb.exe -h127.0.0.1 -uroot -pinvoice123 invoice_bot`
- 换机器时要改 `scripts/*.bat` 里的 `MYSQL_HOME` 和 `config.json` 的 mysql 段

## 新电脑部署（协助用户时的操作依据）

完整用户版步骤在 `docs/使用说明.md`「新电脑部署指南」。AI 协助部署/排查时的要点：

1. **裸机顺序**：Node.js LTS → `npm config set registry https://registry.npmmirror.com` → **装 MySQL 便携版并初始化**（见下）→ 复制项目（带 data/两个数据文件夹 + config.json，**不带 node_modules 和 state-1688.json**）→ `npm install` → `set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` + `npx playwright install chromium`（同窗口连续执行）→ 改 `scripts/*.bat` 的 MYSQL_HOME → `node import-to-db.js` → `node login.js` 扫码 → `node refresh-status.js`（可选）→ `node server.js`
2. **MySQL 便携版安装**：下载 `https://mirrors.tuna.tsinghua.edu.cn/mariadb/mariadb-11.4.13/winx64-packages/mariadb-11.4.13-winx64.zip` → 解压到无中文路径 → 写 `my.ini`（basedir/datadir/port/utf8mb4）→ `bin\mysql_install_db.exe --datadir=... --password=invoice123 --port=3306` → `bin\mysqld.exe --defaults-file=...` 启动
3. **常见故障对照**：
   - `npm install` 卡住 → 镜像没设置或没生效（`npm config get registry` 核对）
   - `node -v` 找不到命令 → PATH 问题，重装 Node 勾选 Add to PATH
   - 看板 /api/data 报 `ECONNREFUSED 127.0.0.1:3306` → MySQL 没启动，跑 `scripts\mysql-start.bat`
   - `Access denied for user 'root'` → 初始化时的 `--password` 与 config.json 里不一致
   - 看板卡片全是 0 / 无卖家 → 没跑 `node import-to-db.js`，或 `data/完成订单` 是空的
   - login.js 浏览器弹不出 → 终端管控拦截 Chromium（公司电脑常见），需 IT 白名单
   - chromium 下载慢/失败 → PLAYWRIGHT_DOWNLOAD_HOST 未设置或换了命令行窗口（set 只对当前窗口生效）
   - 控制台打不开 → 杀软/防火墙拦 Node 或 8787 端口
4. **迁移红线**：config.json 含账号凭据与数据库密码，指导用户传输时必须提醒用 U 盘等安全方式，不得让用户把内容粘贴到任何在线渠道；`data/state-1688.json` 跨机必失效，一律重新 login
5. **部署验收**：必须让用户选一家小额卖家实测催收（消息真实送达+已读）再放批量，不要只看页面能打开就算通过
6. **多机约束**：同一 1688 账号不可两台机器同时运行 server/发送（互踢登录态+风控），部署新机时提醒停掉旧机

## 二次开发流程

1. 读本文档「文件地图」定位目标文件，Read 目标区域（不全量读大文件）
2. 修改前确认与「核心机制速查」「硬约束」无冲突
3. 实现 + `node --check <file>` 语法校验
4. 按测试纪律验证（发送类：1 家实测+聊天记录确认；server 类：重启+curl API；数据库类：实际导入+查库核对）
5. **同步更新三处**：代码注释（如有）、`docs/使用说明.md`、`docs/开发者需求文档.md` 对应章节（表结构/接口/踩坑）
6. 汇报时说明：改了什么文件、验证结果、更新了哪份文档的哪一节
