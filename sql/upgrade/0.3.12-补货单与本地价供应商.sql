-- ============================================================================
-- 0.3.12 补货单管理 + 本地价供应商
--
-- 用途：
--   1) brand_product / product_item 加 local_supplier_id（本地价属于哪个供应商）
--   2) app_user 加 replenish_order_enabled（「补货单管理」菜单开关）
--      · 加列瞬间把主体账号（owner_id IS NULL）的值对齐它自己的 waybill_enabled，
--        免得老板升级完看不见新菜单；员工一律 0，由老板在员工管理里按需勾。
--   3) 新建 replenish_order / replenish_order_item 两张表（采用补货建议生成的补货单）
--
-- 执行：mysql -u<user> -p <dbname> < 0.3.12-补货单与本地价供应商.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：所有加列/建表前都先查 information_schema，重复执行安全
--
-- 回滚：
--   ALTER TABLE `brand_product` DROP COLUMN `local_supplier_id`;
--   ALTER TABLE `product_item`  DROP COLUMN `local_supplier_id`;
--   ALTER TABLE `app_user`      DROP COLUMN `replenish_order_enabled`;
--   DROP TABLE IF EXISTS `replenish_order_item`;
--   DROP TABLE IF EXISTS `replenish_order`;
-- ============================================================================

SET @db := DATABASE();

-- ── 1. 本地价供应商 ─────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'local_supplier_id') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `local_supplier_id` INT NOT NULL DEFAULT 0 COMMENT ''本地价供应商（supplier.id，0=未指定；v0.3.12）'' AFTER `local_pack_price`',
  'SELECT ''brand_product.local_supplier_id 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'local_supplier_id') = 0,
  'ALTER TABLE `product_item` ADD COLUMN `local_supplier_id` INT NOT NULL DEFAULT 0 COMMENT ''本地价供应商（supplier.id，0=未指定；v0.3.12）'' AFTER `local_pack_price`',
  'SELECT ''product_item.local_supplier_id 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 补货单管理菜单开关 ───────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'replenish_order_enabled') = 0,
  'ALTER TABLE `app_user` ADD COLUMN `replenish_order_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看补货单管理页（1=开启，超级管理员始终可见；v0.3.12）'' AFTER `waybill_enabled`',
  'SELECT ''app_user.replenish_order_enabled 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 只给主体账号对齐货单管理权限（员工保持 0）；已有该列的库重复执行也安全：
-- 仅在「刚加完列、全员还是 0」的情况下生效，不会覆盖用户之后手工改的值。
UPDATE `app_user`
   SET `replenish_order_enabled` = `waybill_enabled`
 WHERE `owner_id` IS NULL
   AND `replenish_order_enabled` = 0
   AND `waybill_enabled` = 1;

-- ── 3. 补货单主表 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `replenish_order` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id；0=本地价没指定供应商）',
  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '生成时的供应商名称快照',
  `channel`       VARCHAR(8)    NOT NULL DEFAULT ''  COMMENT '主要渠道：local/qht/afa/jd/mixed',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '补货单金额（明细行总额之和）',
  `item_count`    INT           NOT NULL DEFAULT 0   COMMENT '商品行数',
  `qty_total`     INT           NOT NULL DEFAULT 0   COMMENT '补货数量合计（件）',
  `batch_id`      VARCHAR(64)   DEFAULT NULL         COMMENT '来源补货文件批次（product_import_batch.id）',
  `waybill_id`    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '关联的货单（waybill.id，0=未关联）',
  `waybill_amount` DECIMAL(12,2) DEFAULT NULL        COMMENT '关联时的货单金额快照（用于列表对比）',
  `linked_at`     DATETIME      DEFAULT NULL         COMMENT '关联时间',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '生成人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成日期',
  `deleted_at`    DATETIME      DEFAULT NULL         COMMENT '软删除时间（NULL=有效）',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ro_user_time` (`user_id`, `created_at`),
  KEY `idx_ro_user_sup`  (`user_id`, `supplier_id`),
  KEY `idx_ro_alive`     (`user_id`, `deleted_at`),
  KEY `idx_ro_waybill`   (`waybill_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货单（采用补货建议生成，按供应商归集）';

-- ── 4. 补货单明细 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `replenish_order_item` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL           COMMENT '所属补货单（replenish_order.id）',
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户',
  `sku`           VARCHAR(64)   NOT NULL             COMMENT '商品SKU',
  `goods_name`    VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '生成时的商品名称快照',
  `channel`       VARCHAR(8)    NOT NULL DEFAULT ''  COMMENT '价源：local/qht/afa/jd',
  `channel_label` VARCHAR(32)   NOT NULL DEFAULT ''  COMMENT '价源显示名（齐货通/永源顺/京东万商/供应商名）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '该行的供应商（supplier.id，0=未指定）',
  `suggest_qty`   DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '建议量（基础单位，可被用户改过）',
  `spec_qty`      DECIMAL(12,2) NOT NULL DEFAULT 1.00 COMMENT '规格（一件含多少基础单位；无规格按 1）',
  `qty_pack`      INT           NOT NULL DEFAULT 0   COMMENT '补货数量（件）= 向上取整(建议量 ÷ 规格)',
  `unit_price`    DECIMAL(12,4) NOT NULL DEFAULT 0.0000 COMMENT '最低单价（元/基础单位）',
  `pack_price`    DECIMAL(12,2) DEFAULT NULL         COMMENT '整件价（单价 × 规格）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '行总额（补货数量 × 规格 × 单价）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_roi_order` (`order_id`, `user_id`),
  KEY `idx_roi_sku`   (`user_id`, `sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货单明细（每个 SKU 一行，含价源与折算依据）';
