-- 0.3.28 齐货通手工价：新建 product_price_manual
-- 用途：
--   平台取到的齐货通价错了（或没关联到齐货通商品）时，允许人工填一份价：
--   单价 / 整件价 / 规格，按「品牌方 + SKU + 来源」唯一。
--   **优先级高于 goods_price_cache**：比价分析与补货单都按这份手工价算，
--   点「重新取价」也不会覆盖它（页面标「手工」，要回平台价点「取消手工价」）。
--   kind 目前只放行 qht，字段留通用以便以后给阿发/京东也加。
-- 执行：node server.js 启动时 migrate() 会自动建这张表；本文件用于全新库手工建 / 版本存档。
--       两者等效，执行其一即可（脚本自身幂等，重复跑不会报错）。
-- 回滚：DROP TABLE IF EXISTS `product_price_manual`;
--       （纯新增表，不涉及任何既有数据的改写）

CREATE TABLE IF NOT EXISTS `product_price_manual` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `brand_id`    INT           NOT NULL DEFAULT 0     COMMENT '品牌方（brand.id）：同品牌共用一份',
  `sku`         VARCHAR(64)   NOT NULL               COMMENT '商品SKU',
  `kind`        VARCHAR(8)    NOT NULL DEFAULT 'qht' COMMENT '价格来源：qht=齐货通（暂时只有这一种）',
  `goods_name`  VARCHAR(512)  NOT NULL DEFAULT ''    COMMENT '商品名称快照（改价时带出，便于核对）',
  `unit_price`  DECIMAL(12,4) DEFAULT NULL           COMMENT '手工单价（折合小单位，元）',
  `pack_price`  DECIMAL(12,2) DEFAULT NULL           COMMENT '手工整件价（元/件）',
  `pack_qty`    DECIMAL(12,2) DEFAULT NULL           COMMENT '一件含多少小单位（规格数量）',
  `spec`        VARCHAR(64)   DEFAULT NULL           COMMENT '规格文案（没有规格数量时直接显示它）',
  `small_unit`  VARCHAR(16)   DEFAULT NULL           COMMENT '小单位（瓶/罐/支）',
  `note`        VARCHAR(255)  DEFAULT NULL           COMMENT '改价原因（备注）',
  `updated_by`  VARCHAR(64)   DEFAULT NULL           COMMENT '最后改价人（登录账号）',
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次填写时间',
  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ppm_scope` (`brand_id`, `sku`, `kind`),
  KEY `idx_ppm_kind` (`kind`, `brand_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品手工价（人工覆盖平台取价，比价与补货单优先用它）';
