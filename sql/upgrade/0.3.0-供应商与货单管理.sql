-- ============================================================================
-- 升级脚本 v0.3.0 · 供应商管理 + 货单管理（含手机扫码上传图片）
-- ----------------------------------------------------------------------------
-- 变更内容：
--   ① app_user 加两列（两个新菜单的开关，默认关闭，超管恒可用）
--        supplier_enabled  供应商管理页
--        waybill_enabled   货单管理页
--   ② 新建 supplier              —— 供应商字典（按账号隔离，同账号下名称唯一）
--   ③ 新建 waybill               —— 货单台账（供应商 + 金额 + 货单日期 + 备注）
--   ④ 新建 waybill_image         —— 货单图片（只存七牛对象 key；waybill_id=0 表示待绑定）
--   ⑤ 新建 waybill_upload_token  —— 手机扫码上传的 5 分钟临时令牌
--   ⑥ 一次性回填「员工有的菜单，主体默认也有」（只加不减）
--        v0.3.0 起，主体账号给员工开的菜单，主体自己也应该有；历史上「员工有、主体没有」
--        的账号在本次升级里补齐。程序每次启动也会跑同样一条幂等 UPDATE。
--
-- 业务口径：
--   · 员工录入的供应商/货单归属所属主体账号（user_id = 主体 id），老板能看到全部；
--   · 货单图片存七牛，库里只有对象 key，展示时现签 1 小时临时链接；
--   · 手机上传靠 token（32 位十六进制，5 分钟有效，最多 9 张），token 只能传图，
--     读不到任何已有数据；令牌由电脑端「新建货单 → 生成手机上传链接」发放。
--
-- 前置条件（要能传图）：
--   config.json 的 qiniu 段已配好（与 v0.2.108 售后凭证共用同一套空间与域名）。
--   未配置时服务端仍能正常启动，只是点「生成链接 / 本机选图」会提示「还没配置七牛」。
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.3.0-供应商与货单管理.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--   什么都不做也可以 —— 程序启动时 db.js 的 migrate() 会自动加列 / 建表 / 回填
--
-- 幂等性：加列前查 information_schema，建表用 IF NOT EXISTS，回填是 GREATEST 只加不减
--         —— 重复执行不报错、不改坏已有数据。
--
-- 回滚：
--   DROP TABLE IF EXISTS `waybill_upload_token`;
--   DROP TABLE IF EXISTS `waybill_image`;
--   DROP TABLE IF EXISTS `waybill`;
--   DROP TABLE IF EXISTS `supplier`;
--   ALTER TABLE `app_user` DROP COLUMN `supplier_enabled`, DROP COLUMN `waybill_enabled`;
--   （删表会丢已录入的货单/供应商；七牛上的图片对象不受影响，
--     需要一并清图时到七牛控制台按前缀 waybill/ 批量删除。菜单权限回填不可逆，但只影响可见性。）
-- ============================================================================

SET @db := DATABASE();

-- ① app_user 两个菜单开关 ----------------------------------------------------
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'supplier_enabled') > 0,
  'SELECT ''supplier_enabled 已存在，跳过'' AS msg',
  'ALTER TABLE `app_user` ADD COLUMN `supplier_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看供应商管理页（1=开启，超级管理员始终可见）'''
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'waybill_enabled') > 0,
  'SELECT ''waybill_enabled 已存在，跳过'' AS msg',
  'ALTER TABLE `app_user` ADD COLUMN `waybill_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看货单管理页（1=开启，超级管理员始终可见）'''
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ② supplier ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `supplier` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `name`       VARCHAR(64)   NOT NULL             COMMENT '供应商名称（同账号下唯一）',
  `note`       VARCHAR(255)  DEFAULT NULL         COMMENT '备注（联系方式、结算方式等）',
  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_supplier_user_name` (`user_id`, `name`),
  KEY `idx_supplier_user` (`user_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='供应商字典（供应商管理页维护，货单引用）';

-- ③ waybill -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id）',
  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '建单时的供应商名称快照（供应商被删时兜底展示）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '货单金额（元）',
  `bill_date`     DATE          NOT NULL             COMMENT '货单日期（按此列查询与排序）',
  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_waybill_user_date`  (`user_id`, `bill_date`),
  KEY `idx_waybill_user_sup`   (`user_id`, `supplier_id`),
  KEY `idx_waybill_user_ctime` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单（供应商 + 金额 + 货单日期 + 图片）';

-- ④ waybill_image -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill_image` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `waybill_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '所属货单（0=还没绑定，等电脑端点保存）',
  `token`      CHAR(32)      DEFAULT NULL         COMMENT '上传时用的临时令牌（绑定后清空）',
  `object_key` VARCHAR(512)  NOT NULL             COMMENT '七牛对象 key（不含域名，展示时签名）',
  `mime`       VARCHAR(64)   DEFAULT NULL         COMMENT '图片类型（image/jpeg 等）',
  `size`       INT UNSIGNED  DEFAULT NULL         COMMENT '图片字节数',
  `sort`       INT           NOT NULL DEFAULT 0   COMMENT '同单内展示顺序',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wi_waybill` (`waybill_id`, `user_id`, `sort`),
  KEY `idx_wi_token`   (`token`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单图片（存七牛 key；waybill_id=0 为待绑定）';

-- ⑤ waybill_upload_token ----------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill_upload_token` (
  `token`      CHAR(32)      NOT NULL             COMMENT '32 位十六进制随机串（URL 里带 ?t=）',
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '图片归属用户（= 生成链接的人所属主体）',
  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '生成链接的人（登录账号）',
  `expires_at` DATETIME      NOT NULL             COMMENT '失效时间（NOW()+5 分钟）',
  `used_count` INT           NOT NULL DEFAULT 0   COMMENT '已成功上传张数（仅统计）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token`),
  KEY `idx_wut_expire` (`expires_at`),
  KEY `idx_wut_user`   (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单图片的手机上传临时令牌（5 分钟有效）';

-- ⑥ 回填：员工有 → 主体也有（只加不减）---------------------------------------
-- 注意：这里写死列名，与 db.js migrate() 的 MENU_COLS 保持一致；
--       若某个老库缺列（例如从未加过 price_enabled），整条语句会报 Unknown column，
--       所以逐列用 IF 包一层：缺列的跳过。
SET @cols := 'qnh_refund_enabled,qnh_profit_enabled,product_enabled,market_enabled,billing_enabled,replenish_enabled,price_enabled,after_sale_enabled,supplier_enabled,waybill_enabled';

SET @exists := (
  SELECT GROUP_CONCAT(COLUMN_NAME) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user'
     AND FIND_IN_SET(COLUMN_NAME, @cols) > 0
);
-- 逐列判断：缺列的传给 CONCAT_WS 的是 NULL，会被自动跳过（老库可能从没加过 price_enabled）。
-- ⚠ 不用 WHILE 循环：MySQL / MariaDB 的裸脚本里不支持复合语句（只在存储过程里能用）。
SET @pick := CONCAT_WS(', ',
  IF(FIND_IN_SET('qnh_refund_enabled', @exists), 'MAX(`qnh_refund_enabled`)', NULL),
  IF(FIND_IN_SET('qnh_profit_enabled', @exists), 'MAX(`qnh_profit_enabled`)', NULL),
  IF(FIND_IN_SET('product_enabled',    @exists), 'MAX(`product_enabled`)',    NULL),
  IF(FIND_IN_SET('market_enabled',     @exists), 'MAX(`market_enabled`)',     NULL),
  IF(FIND_IN_SET('billing_enabled',    @exists), 'MAX(`billing_enabled`)',    NULL),
  IF(FIND_IN_SET('replenish_enabled',  @exists), 'MAX(`replenish_enabled`)',  NULL),
  IF(FIND_IN_SET('price_enabled',      @exists), 'MAX(`price_enabled`)',      NULL),
  IF(FIND_IN_SET('after_sale_enabled', @exists), 'MAX(`after_sale_enabled`)', NULL),
  IF(FIND_IN_SET('supplier_enabled',   @exists), 'MAX(`supplier_enabled`)',   NULL),
  IF(FIND_IN_SET('waybill_enabled',    @exists), 'MAX(`waybill_enabled`)',    NULL)
);
SET @sets := CONCAT_WS(', ',
  IF(FIND_IN_SET('qnh_refund_enabled', @exists), 'o.`qnh_refund_enabled` = GREATEST(o.`qnh_refund_enabled`, s.`qnh_refund_enabled`)', NULL),
  IF(FIND_IN_SET('qnh_profit_enabled', @exists), 'o.`qnh_profit_enabled` = GREATEST(o.`qnh_profit_enabled`, s.`qnh_profit_enabled`)', NULL),
  IF(FIND_IN_SET('product_enabled',    @exists), 'o.`product_enabled`    = GREATEST(o.`product_enabled`,    s.`product_enabled`)',    NULL),
  IF(FIND_IN_SET('market_enabled',     @exists), 'o.`market_enabled`     = GREATEST(o.`market_enabled`,     s.`market_enabled`)',     NULL),
  IF(FIND_IN_SET('billing_enabled',    @exists), 'o.`billing_enabled`    = GREATEST(o.`billing_enabled`,    s.`billing_enabled`)',    NULL),
  IF(FIND_IN_SET('replenish_enabled',  @exists), 'o.`replenish_enabled`  = GREATEST(o.`replenish_enabled`,  s.`replenish_enabled`)',  NULL),
  IF(FIND_IN_SET('price_enabled',      @exists), 'o.`price_enabled`      = GREATEST(o.`price_enabled`,      s.`price_enabled`)',      NULL),
  IF(FIND_IN_SET('after_sale_enabled', @exists), 'o.`after_sale_enabled` = GREATEST(o.`after_sale_enabled`, s.`after_sale_enabled`)', NULL),
  IF(FIND_IN_SET('supplier_enabled',   @exists), 'o.`supplier_enabled`   = GREATEST(o.`supplier_enabled`,   s.`supplier_enabled`)',   NULL),
  IF(FIND_IN_SET('waybill_enabled',    @exists), 'o.`waybill_enabled`    = GREATEST(o.`waybill_enabled`,    s.`waybill_enabled`)',    NULL)
);

SET @sql := IF(@sets = '',
  'SELECT ''没有可回填的菜单列，跳过'' AS msg',
  CONCAT('UPDATE `app_user` o JOIN (SELECT owner_id, ', @pick,
         ' FROM `app_user` WHERE owner_id IS NOT NULL AND owner_id > 0 GROUP BY owner_id',
         ') s ON s.owner_id = o.id SET ', @sets)
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 执行后自检：四张表都在、两列都在、回填效果（员工有而主体没有的账号数应为 0）
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME IN ('supplier','waybill','waybill_image','waybill_upload_token')) AS tables_created,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user'
      AND COLUMN_NAME IN ('supplier_enabled','waybill_enabled')) AS cols_added,
  (SELECT COUNT(*) FROM supplier) AS supplier_rows,
  (SELECT COUNT(*) FROM waybill) AS waybill_rows;
