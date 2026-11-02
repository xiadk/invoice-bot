-- ============================================================================
-- 升级脚本 v0.2.106 · 手工售后台账 + 员工只看授权菜单
-- ----------------------------------------------------------------------------
-- 变更内容：
--   ① 新建 qnh_after_manual —— 售后管理页「新增售后」录入的记录
--        与 qnh_refund_order 完全分开：
--          · qnh_refund_order  牵牛花同步来的平台退单（有退单号/订单号/门店）
--          · qnh_after_manual  人工记账（线下单、客诉、补发等没有平台退单号的情况）
--        牵牛花同步只认自己的表，永远不会碰这张表，所以手工记录不会被同步冲掉。
--        售后列表在 lib/qnh.js 的 listAfterSales() 里用 UNION ALL 合并成一页；
--        退单列表 / 统计卡 / 趋势图只读 qnh_refund_order，手工记录不会串过去。
--   ② 无表结构变更的纯前端项（一并记在这里，便于回溯）：
--        · 员工账号（app_user.owner_id 非空）登录后隐藏「发票」整组菜单，
--          只能看到主体账号授权给他的菜单
--        · 售后管理列表去掉「退单号」「门店」两列
--
-- 注意：qnh_* 表历来由 db.js 建（不在 sql/schema.sql 里），所以「全新建库口径」落在
--       db.js 的 ensureQnhSchema()，本脚本只负责老库补表，效果与重启服务自动迁移一致。
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.2.106-手工售后台账.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--   什么都不做也可以 —— 程序启动时 db.js 的 migrate() 会自动建表
--
-- 幂等性：CREATE TABLE IF NOT EXISTS，重复执行不报错、不影响已有数据。
--
-- 回滚：
--   DROP TABLE IF EXISTS `qnh_after_manual`;
--   （只删手工录入的售后记录，平台退单 qnh_refund_order 完全不受影响）
-- ============================================================================

SET @db := DATABASE();

CREATE TABLE IF NOT EXISTS `qnh_after_manual` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `sku`         VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '商品SKU（从商品列表搜索选中）',
  `goods_name`  VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '商品名称（选中后可手改，兼容搜不到的商品）',
  `image_url`   VARCHAR(512)  DEFAULT NULL         COMMENT '商品主图（选中商品时带上，仅展示用）',
  `qty`         INT           NOT NULL DEFAULT 1   COMMENT '售后数量',
  `apply_reason` VARCHAR(512) DEFAULT NULL         COMMENT '售后原因（人工填写）',
  `status`      TINYINT       NOT NULL DEFAULT 0   COMMENT '售后处理状态：0待处理 1已申请 2已退货 3已退款',
  `note`        VARCHAR(255)  DEFAULT NULL         COMMENT '处理备注',
  `handled_by`  VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人',
  `handled_at`  DATETIME      DEFAULT NULL         COMMENT '最后处理时间',
  `created_by`  VARCHAR(64)   DEFAULT NULL         COMMENT '录入人',
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_qam_user_time`   (`user_id`, `created_at`),
  KEY `idx_qam_user_status` (`user_id`, `status`),
  KEY `idx_qam_sku`         (`user_id`, `sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='手工登记的售后（售后管理页「新增售后」）';

-- 执行后自检：表已建好、当前手工记录数（新装为 0）
SELECT COUNT(*) AS manual_rows FROM `qnh_after_manual`;
