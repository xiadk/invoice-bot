---
title: "催收小助手 · Electron 单机版实施方案"
version: 0.1（方案稿，待确认）
date: 2026-10-14
status: draft
supersedes-docs:
  - 方案C_用户自带浏览器.md（2026-10-14 已删除）
  - 方案C_实现说明.md（2026-10-14 已删除）
  - 云端部署Docker.md（2026-10-14 移出 docs/，归档于 data/backups/legacy-cleanup-2026-10-14/）
---

# 催收小助手 · Electron 单机版实施方案

> **一句话**：把现在「服务端 MariaDB + 用户装浏览器扩展 + 配对 WS」的多租户 SaaS，改造成**一个 Windows exe**——内置浏览器窗口自己驱动 1688 发送，数据存本地，授权用离线签名码，收款走平台回调。

---

## 0. 先明确「放弃什么、得到什么」

| | 现在（方案C 多租户） | 改造后（Electron 单机版） |
|---|---|---|
| 用户要装什么 | 浏览器扩展（开发者模式/商店）+ 手填服务器地址 + 配对码 | **一个 exe** |
| 登录态存哪 | 用户自己浏览器 profile | **应用内置浏览器 profile（本地）** |
| 谁驱动 1688 | 扩展 `content.js` 注入用户浏览器 | **主进程 `webContents` 直接驱动内置窗口** |
| 数据存哪 | 服务端 MariaDB，多租户 `user_id` 隔离 | **本地单库（推荐 SQLite 单文件）** |
| 账号体系 | `app_user` + 登录 + admin 管理 | **删除**（本地单用户） |
| 云端服务 | 必须（看板/admin/库） | **可选**（仅授权签发 + 收款回调） |
| 1688 风控 | 真实 IP / 真实浏览器（低） | **不变**（仍是真实 IP、真实登录） |
| 你的风险面 | 服务端存登录态、被扫被攻击、备案 | **无公网服务**，风险面大幅缩小 |

**核心红利**：扩展 + WS 配对 + agent-hub + 多租户 + MariaDB 安装，**全部消失**，替换为一套内置浏览器驱动逻辑。

---

## 1. 总体架构

```
┌─────────────────────────── invoice-bot.exe（单个进程树）───────────────────────────┐
│                                                                                     │
│  ┌─ 主进程 (Node) ───────────────────────────────────────────────────────────────┐  │
│  │  app / 窗口管理 / 菜单 / 单实例锁 / 日志                                        │  │
│  │  ├─ local-server   ← 由现有 server.js 裁剪而来（去 auth/多租户/agent-hub）      │  │
│  │  │    监听 127.0.0.1:<随机端口>，仅本机可访问，带一次性 token                    │  │
│  │  ├─ store         ← 数据层（SQLite 或 JSON，对外统一接口）                       │  │
│  │  ├─ importer      ← 复用 import-to-db.js（Excel 解析 + 增量去重 + 映射回填）     │  │
│  │  ├─ sender engine ← 【新】驱动内置浏览器发消息（合并 content.js + sender.js）     │  │
│  │  └─ license       ← 【新】授权校验（Ed25519 离线）+ 试用期                      │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌─ 窗口1：控制台 ─────────┐   ┌─ 窗口2：1688 发送窗 ──────────────────────────┐   │
│  │ 加载 dashboard.html     │   │ BrowserWindow(partition:'persist:1688')      │   │
│  │ 通过 http://127.0.0.1   │   │ 打开 air.1688.com 聊天页 → 注入脚本 → 发送    │   │
│  │ （复用现有前端，几乎不改）│   │ 登录态留在此 profile，用户只登一次             │   │
│  └────────────────────────┘   └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 仅两件事需要联网（均可离线降级）
                                    ▼
                        ┌───────────────────────────┐
                        │ 授权/收款服务（你自己的轻服务）│
                        │ · 收款回调 → 签发授权码      │
                        │ · 授权码 = Ed25519 签名       │
                        └───────────────────────────┘
```

**关键设计取舍**：控制台窗口**不做成 `file://` 直载**，而是让主进程跑一个**只绑 `127.0.0.1` 的本地 HTTP 服务**，窗口加载 `http://127.0.0.1:<port>/`。
- 理由：`dashboard.html`（97KB）现在是 `fetch('/api/*')` 模式，本地 HTTP 能让**它几乎一行不改**就用起来；改成 IPC 要重写全部请求层，代价大、收益低。
- 安全兜底：只绑回环地址 + 每次启动生成随机端口 + 随机 token（前端请求带 header）。这个端口**外网不可达**，与「服务端暴露」是两回事。

---

## 2. 目录结构（新增 `electron/`，保留可复用模块）

```
invoice-bot/
├─ electron/                        ← 【新】Electron 外壳
│  ├─ main.js                       主进程入口（窗口/生命周期/单实例）
│  ├─ preload.js                    contextBridge 白名单（控制台窗口用）
│  ├─ ipc.js                        IPC 路由（打开文件夹/授权状态/发送控制）
│  ├─ app-config.js                 应用配置读写（%APPDATA%/invoice-bot/config.json）
│  └─ windows.js                    窗口创建（控制台窗 + 1688 发送窗）
├─ src/                             ← 【新】单机版业务内核（从根目录模块迁移/改写）
│  ├─ store/                        数据层
│  │  ├─ index.js                   统一接口（getCompanies/importOrders/saveMapping…）
│  │  ├─ sqlite.js                  SQLite 实现（better-sqlite3）
│  │  └─ schema.sql                 ← 由 sql/schema.sql 改写（去 user_id 唯一键、加 SQLite 类型）
│  ├─ importer/                     ← 由 import-to-db.js 迁移
│  ├─ sender/
│  │  ├─ engine.js                  【核心】内置浏览器驱动发送
│  │  ├─ inject.js                  注入 1688 页面的脚本（由 extension/content.js 改写）
│  │  └─ messages.js                ← 由 lib/sender.js 的 buildMessages 迁移
│  ├─ license/
│  │  ├─ verify.js                  Ed25519 离线校验 + 机器指纹
│  │  └─ fingerprint.js             机器码生成
│  └─ server/                       ← 由 server.js 裁剪（去 auth/多租户/agent-hub）
├─ ui/                              ← 现有 dashboard.html / login.html 迁入（去登录）
├─ build/                           ← 图标、安装脚本、electron-builder 配置
├─ package.json                     新增 electron / electron-builder / better-sqlite3 依赖
└─ docs/
```

**删除清单**（整个删除，不是注释）：`extension/`、`lib/agent-hub.js`、`lib/auth.js`、`lib/tenancy.js`、
`login.html`、`download.html`、`bookmarklet.html`、`server.js` 中的 `/api/auth/*`、`/api/admin/*`、
`/api/agent/*`、`app_user` 表、`login_state` 表、`agent_task` 表。

---

## 3. 数据层：MariaDB → 本地库

### 3.1 推荐 SQLite（而非纯 JSON）

你最初说「不要数据库，数据存 JSON」。**目标我认同（用户不用装数据库），但实现建议改 SQLite**——它同样是「单文件、零安装、不用起服务」，区别只在工程成本：

| | 纯 JSON | SQLite（better-sqlite3） |
|---|---|---|
| 现有 SQL | `server.js` 里**全部手写 SQL 要重写成内存过滤**（聚合/分组/JOIN 尤其痛） | **几乎照搬**，只改方言（`AUTO_INCREMENT`→`AUTOINCREMENT` 等） |
| 事务 | 无，导入一半失败 = 数据半残 | ACID |
| 崩溃安全 | 全量重写文件，断电即损坏（要自己写 temp+rename+fsync+滚动备份） | 天然安全（WAL） |
| 索引/性能 | 每次全量载入内存 | 有索引，12k 单无压力 |
| 用户可读 | ✓ 记事本可看 | 需工具（但可导出 JSON 供查看） |

**结论**：用 SQLite，但**把数据层封装成 `src/store/index.js` 统一接口**——万一你以后仍想要 JSON，只换 `store/json.js` 实现，业务层不动。**这样「JSON 还是 SQLite」变成一个可后置的开关，不再阻塞开工。**

> 若你坚持纯 JSON：成本主要是「重写 `server.js` 里全部查询」+「自己实现原子写与备份」，工作量约 +1～2 天，且长期要防文件损坏。我建议不这么做，但可以按你的决定来。

### 3.2 schema 迁移要点（`sql/schema.sql` → `src/store/schema.sql`）

- **删掉 `app_user` 表**（单机无登录）。
- **删掉所有 `user_id` 列与相关索引/唯一键**：`uk_user_row_hash(user_id,row_hash)` → `UNIQUE(row_hash)`；`uk_user_tax_name(user_id,tax_seller_name)` → `UNIQUE(tax_seller_name)`。
- **`invoice_order` 主键仍是 `order_no`**（符合「按订单号去重」的既定逻辑，无需改）。
- **保留但简化**：`issued_invoice` / `seller_name_mapping` / `send_log` / `import_log` 结构不变，仅去 `user_id`。
- **删除 `agent_task` 表**（任务不再需要服务端排队，发送在主进程内同步编排）。
- **`send_log` 增加本地发送上下文**：`message_text TEXT`（便于「防重复发送」和风控台账）、`channel TEXT DEFAULT 'local'`。
- 新增 `app_meta` 表：存 `schema_version`、`license_state`、`trial_started_at` 等本地元数据。

### 3.3 `db.js` 的处置

现有 `db.js`（mysql2 连接池 + `env` 优先）**整体替换**为 `src/store/sqlite.js`（better-sqlite3，同步 API，不需要连接池）。注意：`server.js` 里大量 `await pool.query(...)` 调用点，better-sqlite3 是**同步**的——保留 `await` 语法无害（同步值 await 即自身），可**零改动兼容**，这是选它而非 node:sqlite 的现实理由。

---

## 4. 【核心】内置浏览器与 1688 注入层

这是整个方案的技术内核，也是最该一次做对的地方。

### 4.1 现状：两套重复实现

| 现有实现 | 位置 | 作用 |
|---|---|---|
| Playwright 引擎 | `lib/sender.js` `sendToSeller()` | 服务端开浏览器发消息（**已退役**，但选择器逻辑是宝贵资产） |
| 扩展注入脚本 | `extension/content.js` `sendMessages()` | 在用户浏览器里发消息（**当前生产通道**） |

**两者做的是同一件事**（开聊天页 → 找编辑器 → 灌文本 → 点发送 → 校验出现在聊天记录）。Electron 版**只需保留一套**，直接跑在 `webContents` 上。

### 4.2 发送窗设计

```js
// 发送窗：独立分区持久化登录态，控制台窗与它互不干扰
const sendWin = new BrowserWindow({
  show: false,                       // 首次登录时临时 show，之后常驻隐藏
  webPreferences: {
    partition: 'persist:1688',       // ← 登录态存本地硬盘，用户只登一次
    nodeIntegration: false,          // ← 必须：绝不给 1688 页面 Node 能力
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  },
});
```

**UA 伪装（必做，否则风控一眼识别）**：

```js
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
app.userAgentFallback = REAL_UA;                      // 全局兜底
sendWin.webContents.setUserAgent(REAL_UA);            // 发送窗强制
sendWin.webContents.session.setUserAgent(REAL_UA);
// 注意：不要改 navigator.webdriver（Electron 默认不为 true，改了反而异常）
```

### 4.3 驱动方式：定位聊天 frame 后注入

1688 聊天页（`https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichn<sellerLogin>&siteid=cnalichn&status=1`）的真实编辑器位于**子 iframe**（`def_cbu_web_im_core`）内。`webContents.executeJavaScript` 只在主 frame 执行，因此需要**遍历 frame**：

```js
// 找到聊天核心 frame
function findChatFrame(wc) {
  const walk = (f) => {
    if (/def_cbu_web_im/.test(f.url)) return f;
    for (const c of f.frames) { const r = walk(c); if (r) return r; }
    return null;
  };
  return walk(wc.mainFrame);
}

// 在正确的 frame 里执行注入脚本（inject.js 的源码字符串）
const frame = findChatFrame(sendWin.webContents);
const result = await frame.executeJavaScript(
  `(async () => { ${injectSource} ; return await __sendBatch(${JSON.stringify(messages)}); })()`
);
```

**`inject.js` 直接由 `extension/content.js` 改写**：把 `findEditor / findSendBtn / dismissModals / insertText / pressEnter / historyContains / sendOne / sendMessages` 原样搬过来（这些是纯 DOM 操作，与扩展 API 无关），只把末尾的 `chrome.runtime.onMessage` 通信段删掉，改为导出 `__sendBatch(messages)`。**这部分代码已在实际环境验证过，复用价值极高。**

### 4.4 发送流程（主进程编排）

```
用户点「开始发送」（控制台）
   │
   ├─ 1. 登录态预检：打开聊天页，等编辑器出现；若跳转 login.1688.com → 中止并提示「请先在发送窗登录」
   │
   ├─ 2. 对每个待发送卖家（循环）：
   │      a. loadURL(CHAT_URL(seller.loginId))，等 did-finish-load
   │      b. 轮询等聊天 frame + 编辑器就绪（就绪后才算 start）
   │      c. executeJavaScript(__sendBatch(messages))   ← 逐条发送并校验
   │      d. 写 send_log，向控制台推送进度（当前卖家/成功失败/剩余）
   │      e. 拟人间隔：sendGapMinSec ~ sendGapMaxSec（默认 20~35s，从配置读）
   │
   ├─ 3. 支持「停止」：置停止标志，当前卖家发完即退出循环
   │
   └─ 4. 全部结束：汇总 + 失败明细（截图存本地 data/send-fail-*.png）
```

**进度推送**：发送在主进程，控制台窗在另一个窗口 → 用 `webContents.send('task:progress', {...})`，前端监听 `window.invoiceBot.onProgress(cb)`（由 `preload.js` 的 `contextBridge` 暴露）。**替代原来的 WS `task_progress` / `client_stop` 协议**，更简单、无网络参与。

### 4.5 与现有代码的复用对照

| 功能 | 来源 | Electron 处置 |
|---|---|---|
| 编辑器/发送按钮定位、弹窗清理、输入注入 | `extension/content.js` | **原样复用**（去 chrome API）→ `src/sender/inject.js` |
| 消息组装（模板/清单分块/提醒） | `lib/sender.js#buildMessages` | **原样复用** → `src/sender/messages.js` |
| 拟人间隔、每日上限、重试 | `lib/sender.js` 参数 + `server.js` 发送循环 | 迁移进 `engine.js` |
| 失败截图诊断 | `lib/sender.js` | 复用（路径改到 `app.getPath('userData')/screenshots`） |
| Playwright 依赖 | `lib/sender.js`/`lib/browser.js` | **生产环境删除**（仅测试保留） |

---

## 5. 控制台（前端）改动

`dashboard.html` 前端**基本不动**，只需：

1. **删除登录相关**：`/api/auth/me` 401 跳转、`goLogin()`、`login.html` 引用、右上角用户/角色显示（`#userRole`）。
2. **删除多租户痕迹**：`READONLY`（admin 只读他人）走「永远非只读」；用户管理相关入口（若有）删除。
3. **新增「连接 1688」区块**：显示发送窗登录状态（已登录/未登录 + 一个「打开 1688 登录窗」按钮，调用 IPC）。
4. **新增两处（源自牵牛花那轮的功能建议，本次一并做）**：
   - **登录态预检提示**：未登录时发送按钮置灰 + 明确引导，而非发到一半才失败。
   - **防重复发送过滤**：待发送列表默认隐藏「已成功发送过」的卖家（`send_log` 判定），可手动展开显示。
5. **发送进度面板**：由 WS 监听改为 `window.invoiceBot.onProgress`。

> 建议 v1 仍把 `dashboard.html` 放在 `ui/`，由本地 HTTP 服务提供（改动最小）；后续若想彻底去端口，再迁到 `file:// + IPC`。

---

## 6. 授权与收费系统

### 6.1 三条边界（先说清楚，避免踩坑）

1. **收款无法纯本地**：钱要进账必须经平台（微信/支付宝商户回调、或发卡平台）→ 需要一个极轻的服务端。程序里能做的只是「引导付款 → 轮询/粘贴授权码」。
2. **离线校验必然被破解**：Electron 的 asar 可解包、JS 明文，授权校验几行代码易被 patch。目标**不是防住，而是把破解成本抬到「不如花 99 块买」**。
3. **可以完全离线运行**：校验本身离线（Ed25519 公钥内置），**不联网也能用**——这点很重要，避免「服务器挂了用户全用不了」。

### 6.2 方案

```
签发端（你，离线私钥）                   客户端（exe，内置公钥）
─────────────────────                   ─────────────────────
payload = {                             读授权码 → 验签 → 比对指纹 → 检查到期
  machine: "<机器指纹>",                 失败 → 试用/锁定
  edition: "pro",                       成功 → 解锁全部功能
  issuedAt: 1760...,
  expiresAt: 1780...,
  seats: 1
}
license = base64(payload) + "." + base64(sign(payload, 私钥))
```

- **机器指纹**：`sha256(machineId + 主硬盘卷序列号 + CPU 型号)` 的短哈希。
  - ⚠️ Electron 改动硬件（换硬盘）会变 → 设计成**容错**：允许用户提交「指纹变更申请」，你重签。
  - `app.getPath('userData')/license.key` 存授权码。
- **试用**：首次运行写 `app_meta.trial_started_at`，给 N 天全功能（建议 7 天）；**同时把启动时间写入一个隐藏的多个位置做交叉校验**（防时间回拨——不追求绝对，只要比纯改系统时间麻烦）。
- **收款**：MVP 可先**手工发码**（用户扫码付款 → 你把授权码发给他），量起来后再接发卡平台/微信回调自动发码。**这一步不阻塞开发**。
- **第 3 道防线（可选）**：把「必须联网激活」做成可选策略（首次激活联网、之后离线），但**不做强制联网校验**，否则丢掉离线可用的优点。

> 待你定：**试用期天数**、**定价**、**是否现在就要自动发码**（我建议后置）。

---

## 7. 打包与分发

| 项 | 决策 | 说明 |
|---|---|---|
| 打包工具 | `electron-builder` | 生态最成熟，portable/nsis 都支持 |
| 首版产物 | **nsis 安装版**（单文件 setup.exe） | 比 portable 启动快、更常见；portable 作为备选一并产出 |
| 架构 | **x64** | 覆盖绝大多数 Win10/11；ARM 机器可模拟 |
| 系统下限 | **Windows 10 1809+** | Electron 23+ 已不支持 Win7/8 |
| 体积 | 约 **150–250MB** | 内含 Chromium，是「干掉扩展」的代价 |
| 签名 | **MVP 不签，正式发售前再签** | OV 约 800 元/年（Certum）或 Azure Trusted Signing ~$10/月；EV 换 SmartScreen 即时信任 |
| 自动更新 | **v1 不做**，先手动下载新版 | 做的话用 `electron-updater` + 你自己的更新清单（含版本/哈希/下载地址） |
| 数据位置 | `%APPDATA%/invoice-bot/`（`app.getPath('userData')`） | **绝不写程序目录**（Program Files 无写权限） |

**未签名的两个现实摩擦**（必须提前知道，并写进给用户的说明）：SmartScreen「未知发布者」提示（用户需点「更多信息→仍要运行」）；360/腾讯管家/火绒可能误报——**建议在下载页加一段「如何放行」图文指引**。

`package.json` 新增：

```json
{
  "main": "electron/main.js",
  "scripts": {
    "electron:dev": "electron .",
    "dist:nsis": "electron-builder --win nsis",
    "dist:portable": "electron-builder --win portable"
  },
  "devDependencies": { "electron": "^33", "electron-builder": "^25" },
  "dependencies": { "better-sqlite3": "^11", "xlsx": "^0.18.5" }
}
```

> **`better-sqlite3` 是原生模块**，需 `electron-rebuild` 编译匹配 Electron 的 ABI（这是本方案唯一需要额外配置的构建环节，务必在 M1 阶段就验证通过）。

---

## 8. 安全与合规红线（必须遵守）

- **绝不给 1688 页面 Node 能力**：发送窗 `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true`。
- **绝不采集 1688 凭据**：不读 Cookie、不读密码框、不上传任何页面数据；登录完全由用户在 1688 官方页面完成。**这一点要在下载页和首启弹窗明确告知**（信任是转化率命门）。
- **数据不出本机**：除授权激活外**不发起任何网络请求**（尤其不把订单/发票数据发到任何服务器）。
- **控制台本地服务**只绑 `127.0.0.1` + 随机端口 + token，`ipcMain` 白名单校验调用方窗口。
- **`will-navigate` / `setWindowOpenHandler` 限制**：发送窗只允许停在 `*.1688.com`，其余外链一律 `shell.openExternal` 或拦截，防止被钓鱼跳转。

---

## 9. 风控（1688 封号/封 IP）对照

| 措施 | 状态 |
|---|---|
| 真实 IP、真实登录（非服务端代发） | ✅ 天然满足（且比 SaaS 更好：每个用户独立住宅 IP，无「一锅端」连坐） |
| 拟人间隔 20~35s 随机 | ✅ 保留（`config.runtime.sendGapMinSec/Max`） |
| 每日发送上限（默认 50 家） | ✅ 保留 |
| 登录态预检 | ➕ 本次新增（未登录不发，减少风控暴露） |
| 防重复发送 | ➕ 本次新增（重复消息是风控雷区） |
| 文案随机化 | ➕ 建议加（同模板换措辞，避免几十条雷同被判定群发） |
| 失败退避 + 连续失败自动暂停 | ➕ 建议加（风控期硬推最伤号） |
| UA 伪装成真实 Chrome | ➕ 必做（Electron 默认 UA 含 `Electron/xx`） |
| 不给扩展挂代理/VPN | ✅ 单机版天然无此问题 |

---

## 10. 里程碑（建议顺序）

| 阶段 | 内容 | 产出/验收 |
|---|---|---|
| **M0 骨架** | Electron 起壳：主进程 + 控制台窗（先加载现有 dashboard）+ 单实例锁 + 日志 | 双击可运行，看到控制台（登录先临时旁路） |
| **M1 数据层** | SQLite 迁移 + `store` 统一接口 + `better-sqlite3` 在 Electron 下编译通过 | 导入一份 Excel → 数据落 SQLite → 看板能读出 |
| **M2 发送内核** ⭐ | 发送窗 + UA 伪装 + `inject.js`（由 content.js 改写）+ `engine.js` 编排 + 进度 IPC | **对真实 1688 账号跑通 1 个卖家 → 再跑 1 批**（最关键的一步） |
| **M3 控制台** | 去登录/去多租户 + 「连接1688」区块 + 登录态预检 + 防重复过滤 + 进度面板 | 小白能独立完成「导入→选择→发送→看结果」全流程 |
| **M4 授权** | Ed25519 校验 + 机器指纹 + 试用期 + 授权码输入界面 | 试用到期后可输入授权码解锁；换码/换机可控 |
| **M5 打包** | electron-builder 出 nsis + portable；图标；下载页 + 放行指引 | 在**干净的 Win10/11 机器**上完整跑一遍（含 SmartScreen 提示） |
| **M6 硬化** | 文案随机化、失败退避、日志/诊断导出、崩溃上报（可选） | 稳定可发售 |

**关键路径是 M2**（发送内核）——它决定产品能不能成立；建议 M0/M1 跑通后立刻集中做 M2，用真实账号验证，再回头补 M3 的体验。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 1688 聊天页 DOM 改版 | 发送失效 | 多选择器兜底（现有代码已这么做）+ 失败截图 + **预留「选择器热更新」**（从配置/远端拉选择器） |
| `better-sqlite3` 原生模块编译失败 | 阻塞开工 | M1 第一时间验证；退路：改用 `node:sqlite`（Node 22+ 内置）或 `sql.js`（WASM，无编译，性能略低） |
| 破解漏损 | 收入损失 | 提高破解成本（校验多点散布、关键逻辑与校验耦合）+ 定价不过高；**预期接受一定漏损** |
| 数据丢失（重装/换机） | 用户投诉、售后重 | 内置「一键导出/导入数据」（导出 SQLite + JSON 快照）；**明确告知不代恢复** |
| 杀软误报 | 用户装不上 | 说明页图文指引；后期买签名证书 |
| 用户换机/换硬盘导致授权失效 | 客诉 | 授权容错：允许指纹变更重签（人工服务） |
| 售后成本上升（无服务器代运维） | 运营重 | 内置「诊断包导出」（日志+环境+失败截图）让远程排障变容易 |

---

## 12. 需要你先拍板的 5 件事

1. **数据层**：SQLite（我推荐）还是纯 JSON？（不影响开工，但影响 M1）
2. **打包形态**：首版出 **nsis 安装版** 还是 **portable 免安装**？（我建议 nsis + portable 都出，主推 nsis）
3. **试用与定价**：试用几天？定价档位？（影响 M4）
4. **收款**：v1 先**手工发码**，还是现在就接发卡平台自动发码？（我建议 v1 手工）
5. **控制台形态**：v1 用**本地 HTTP**（改动最小）；还是直接上 `file:// + IPC`（更干净但要改前端请求层）？（我建议 v1 用本地 HTTP）

---

## 13. 与旧方案的关系

> ⚠️ **先看这条**：还存在**另一个可选形态**——`混合模式_网站唤醒本机助手.md`：保留网站 SaaS（账号/数据/看板都在你的服务器），只把「浏览器扩展」换成「本机 Electron 助手」，由网页点「批量发送」时用 `invoicebot://` 深链唤醒。
> **两者是分叉，不是叠加**：本文件是**纯单机版**（数据在用户本地、买断、无服务器）；混合版是**订阅 SaaS + 本地执行器**（数据在你这、不受商店 Bots 政策约束、但要装 exe 且常驻）。**v1 建议只选一条**，见混合版文档 §9 的取舍表。

- 本方案**取代** `方案C_用户自带浏览器.md` / `方案C_实现说明.md`（扩展 + WS 通道整体废弃；两份文档已于 2026-10-14 删除）。
- `云端部署Docker.md` 的定位改变：**不再部署业务服务**，仅在未来需要「统一授权签发 / 发卡回调 / 版本更新清单」时，起一个极轻的服务（或直接用现成发卡平台替代）。该文档已于 2026-10-14 移出 `docs/`，归档在 `data/backups/legacy-cleanup-2026-10-14/`。
- 现有 `extension/` 目录**保留到 M2 验证通过**再删除（作为 `inject.js` 改写时的对照与回退），避免过早删除丢掉已验证的逻辑。
