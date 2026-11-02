-- ============================================================================
-- 0.3.3 齐货通订单（qht_order）
--   用途：账单支出项新增「齐货通当月订单金额」——从齐货通「我的 → 全部订单」
--         接口（/mall/api/goods/orders/myPage）拉回订单落库，账单页实时聚合。
--   执行：服务端启动时 db.js migrate 会自动建表；也可手动执行本脚本。
--   回滚：DROP TABLE IF EXISTS `qht_order`;
--         （删表后账单里齐货通金额归 0，不影响其它支出项）
-- ============================================================================
CREATE TABLE IF NOT EXISTS `qht_order` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`        INT           NOT NULL               COMMENT '数据归属用户（齐货通登录态所属账号）',
  `order_no`       VARCHAR(32)   NOT NULL               COMMENT '订单编号（DD 开头）',
  `status`         TINYINT       NOT NULL DEFAULT 0     COMMENT '平台状态码',
  `status_name`    VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '平台状态名（已发货/已取消/已完成…）',
  `pay_flag`       TINYINT       NOT NULL DEFAULT 0     COMMENT '支付标记：0未支付 1线下部分结款 2线下全部结款',
  `pay_status`     TINYINT       NOT NULL DEFAULT 0     COMMENT '支付状态码（1=已支付，平台语义）',
  `pay_status_name` VARCHAR(32)  NOT NULL DEFAULT ''    COMMENT '支付状态名（已支付/未支付…）',
  `store_name`     VARCHAR(64)   NOT NULL DEFAULT ''    COMMENT '发货仓库',
  `sale_no`        VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '出货单号（XS 开头，部分状态才有）',
  `ipcnt`          INT           NOT NULL DEFAULT 0     COMMENT '件数',
  `spcnt`          INT           NOT NULL DEFAULT 0     COMMENT '散数',
  `payable_money`  DECIMAL(12,2) NOT NULL DEFAULT 0.00  COMMENT '实付款（元）',
  `order_time`     DATETIME      NOT NULL               COMMENT '下单时间（按此列归月）',
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次拉取时间',
  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qo_user_no`  (`user_id`, `order_no`),
  KEY `idx_qo_user_time`      (`user_id`, `order_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='齐货通订单（账单支出项「齐货通当月订单金额」数据源）';
