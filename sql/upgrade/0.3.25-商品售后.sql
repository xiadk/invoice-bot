-- 0.3.25 商品售后：新建 product_after，清理旧的供应商售后台账
-- 用途：
--   1) 新建 product_after（商品名称/SKU + 数量 + 售后原因 + 状态 + 运单号 + 凭证），
--      替代 v0.3.2 的 supplier_after（供应商维度，已不再被页面和代码引用）。
--   2) 清理旧数据（用户 2026-11-04 明确要求删除）：
--      · 删掉供应商售后台账 supplier_after（含其表）
--      · 删掉这批台账的凭证行（qnh_after_attach.row_key 以 'sup:' 开头）
--      ⚠ 这是不可逆操作。执行前如需留档，请先跑下面这行备份：
--         CREATE TABLE `supplier_after_bak_20261104` AS SELECT * FROM `supplier_after`;
-- 执行：node server.js 启动时 migrate() 会自动建 product_after（不会删旧表）；
--       要清掉旧数据，请手工对本库执行本文件一次。
-- 回滚：DROP TABLE IF EXISTS `product_after`;
--       （旧 supplier_after 数据一旦删除无法用脚本恢复，只能靠上面的备份表）

CREATE TABLE IF NOT EXISTS `product_after` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `goods_name`    VARCHAR(255)  NOT NULL DEFAULT ''  COMMENT '商品名称（选中商品自动回填，可手改）',
  `sku`           VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '商品 SKU',
  `qty`           INT           NOT NULL DEFAULT 1   COMMENT '售后数量（件）',
  `after_reason`  VARCHAR(255)  DEFAULT NULL         COMMENT '售后原因',
  `after_date`    DATE          NOT NULL             COMMENT '售后日期（按此列查询与排序）',
  `status`        TINYINT       NOT NULL DEFAULT 0   COMMENT '处理状态：0待处理 1已申请 2已退货 3已退款（人工变更）',
  `waybill_no`    VARCHAR(64)   DEFAULT NULL         COMMENT '退货运单号（状态改到「已退货」时必填）',
  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注',
  `handled_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人（登录账号）',
  `handled_at`    DATETIME      DEFAULT NULL         COMMENT '最后处理时间',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pa_user_date`   (`user_id`, `after_date`),
  KEY `idx_pa_user_sku`    (`user_id`, `sku`),
  KEY `idx_pa_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品售后台账（商品名称/SKU + 数量 + 原因 + 状态 + 运单号 + 凭证）';

-- 旧供应商售后的凭证图（七牛对象保留，只删记录）
DELETE FROM `qnh_after_attach` WHERE `row_key` LIKE 'sup:%';

-- 旧的供应商售后台账表（代码已不再引用）
DROP TABLE IF EXISTS `supplier_after`;
