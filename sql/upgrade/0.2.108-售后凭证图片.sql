-- ============================================================================
-- 升级脚本 v0.2.108 · 售后凭证图片（状态变更必须上传截图）
-- ----------------------------------------------------------------------------
-- 变更内容：
--   ① 新建 qnh_after_attach —— 售后状态变更的凭证图片台账
--        业务口径（v0.2.108 起）：
--          · 售后管理页的状态变更改为「一键推进下一档」：待处理 → 已申请 → 已退货 → 已退款
--          · 每次变更必须上传一张凭证截图（支持 Ctrl+V 粘贴），图片存七牛空间 invoice-bot，
--            库里只存对象 key（object_key），不存完整 URL —— 换域名/换空间不用改历史数据
--          · 展示时由 lib/qiniu.js 的 signUrl() 现签私有空间临时链接（默认 1 小时）
--          · 行键 row_key 与售后列表一致：ref:<退单号> / man:<手工售后id>
--   ② sql/schema.sql 补上 qnh_after_manual + qnh_after_attach 两张表
--        （qnh_* 表历来由 db.js 的 ensureQnhSchema() 建，schema.sql 缺这两张，
--         本次一并补齐，保证全新部署按 schema.sql 建库也完整）
--
-- 前置条件（服务端要能上传图片）：
--   config.json 增加 qiniu 段（该文件不入库）：
--     "qiniu": {
--       "accessKey": "…", "secretKey": "…", "bucket": "invoice-bot",
--       "domain": "http://qiniu.xiadk.pw", "region": "华南",
--       "uploadHost": "https://upload-z2.qiniup.com", "expireSec": 3600
--     }
--   未配置时服务端仍能正常启动，只是点「处理」会提示「还没配置七牛」。
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.2.108-售后凭证图片.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--   什么都不做也可以 —— 程序启动时 db.js 的 migrate() 会自动建表
--
-- 幂等性：CREATE TABLE IF NOT EXISTS，重复执行不报错、不影响已有数据。
--         不影响 qnh_refund_order / qnh_after_manual 里已有的状态与备注。
--
-- 回滚：
--   DROP TABLE IF EXISTS `qnh_after_attach`;
--   （只删凭证图片台账；七牛上的图片对象与售后状态本身都不受影响，
--     需要一并清图时到七牛控制台按前缀 after-sale/ 批量删除）
-- ============================================================================

SET @db := DATABASE();

CREATE TABLE IF NOT EXISTS `qnh_after_attach` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `row_key`     VARCHAR(64)   NOT NULL             COMMENT '售后行键：ref:<退单号> / man:<手工售后id>',
  `status`      TINYINT       NOT NULL DEFAULT 0   COMMENT '本次变更后的处理状态：0待处理 1已申请 2已退货 3已退款',
  `object_key`  VARCHAR(512)  NOT NULL             COMMENT '七牛对象 key（不含域名，展示时签名）',
  `mime`        VARCHAR(64)   DEFAULT NULL         COMMENT '图片类型（image/png 等）',
  `size`        INT UNSIGNED  DEFAULT NULL         COMMENT '图片字节数',
  `note`        VARCHAR(255)  DEFAULT NULL         COMMENT '本次变更的备注（冗余一份，附件单独看也能读到）',
  `created_by`  VARCHAR(64)   DEFAULT NULL         COMMENT '操作人',
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_qaa_row`  (`user_id`, `row_key`, `created_at`),
  KEY `idx_qaa_time` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='售后凭证图片（每次状态变更一张，存七牛 key）';

-- 执行后自检：表已建好、当前凭证数（新装为 0）
SELECT COUNT(*) AS attach_rows FROM `qnh_after_attach`;
