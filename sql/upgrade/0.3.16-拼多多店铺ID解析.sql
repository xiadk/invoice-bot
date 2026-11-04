-- ============================================================================
-- 0.3.16 拼多多「解析店铺 ID」：mall_sn → mall_id
--
-- 背景（为什么必须这么绕）：
--   拼多多订单接口（order_list_v4）的 mall 里只有加密串 mall_url，
--   mall_sn 是 protobuf(6 字段) + 两块 16 字节 AES 密文，解密密钥只在拼多多服务端；
--   前端也只是把 mall_sn 转发给 POST /api/turing/mall/gr_st，且必须带页面现生的 anti_content。
--   服务器直连该接口一律 {"error_code":40002}（前端把它定义成 isIntercept 风控拦截），
--   静态抓 mall_page.html 又是空壳（needLogin / 无 viewCtx）→ 服务端拿不到 mall_id。
--
--   因此改为：本机助手在已登录的真实页面里打开店铺页一次，抓页面自己解出的 mall_id，
--   存进 pdd_mall 缓存并回填 pdd_order.mall_id。解析成功一次永久有效。
--
-- 本脚本做三件事：
--   1) pdd_order 加 mall_sn 列（同步订单时从 mall_url 解析写入）+ 索引
--   2) 建 pdd_mall 缓存表（user_id + mall_sn 主键）
--   3) 回填存量：从 raw_json 里的 mall_url 抠出 mall_sn（只补空值，幂等）
--
-- 执行：mysql -u<user> -p <dbname> < 0.3.16-拼多多店铺ID解析.sql
--       （重启服务时 db.js 的 migrate() 会自动做同样的事，两者等效，跑一次即可）
-- 幂等：所有 DDL 先查 information_schema；回填带 `mall_sn IS NULL` 条件
--
-- 回滚：
--   DROP TABLE IF EXISTS `pdd_mall`;
--   ALTER TABLE `pdd_order` DROP INDEX `idx_pdo_msn`;
--   ALTER TABLE `pdd_order` DROP COLUMN `mall_sn`;
--   （回滚后催收按钮恢复成「必须有 mall_id 才能催」，已解析的数据一并消失）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. pdd_order.mall_sn ────────────────────────────────────────────────────
SET @had_msn := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pdd_order' AND COLUMN_NAME = 'mall_sn'
);
SET @sql := IF(@had_msn = 0,
  'ALTER TABLE `pdd_order` ADD COLUMN `mall_sn` VARCHAR(128) DEFAULT NULL COMMENT ''店铺加密串（mall_url 里的 mall_sn）''',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @had_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pdd_order' AND INDEX_NAME = 'idx_pdo_msn'
);
SET @sql := IF(@had_idx = 0,
  'ALTER TABLE `pdd_order` ADD KEY `idx_pdo_msn` (`user_id`,`mall_sn`)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. pdd_mall 缓存表 ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `pdd_mall` (
  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户',
  `mall_sn` VARCHAR(128) NOT NULL COMMENT '店铺加密串（订单 mall_url 里的 mall_sn）',
  `mall_id` BIGINT DEFAULT NULL COMMENT '解析出的数字店铺 ID（NULL=还没解析成功）',
  `mall_name` VARCHAR(128) DEFAULT NULL COMMENT '店铺名（订单接口的 mall_name，便于人工核对）',
  `fail_reason` VARCHAR(255) DEFAULT NULL COMMENT '最近一次解析失败原因',
  `tried_at` DATETIME DEFAULT NULL COMMENT '最近一次解析尝试时间',
  `agent_ver` VARCHAR(32) DEFAULT NULL COMMENT '执行解析的助手版本',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`,`mall_sn`),
  KEY `idx_pm_mallid` (`user_id`,`mall_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拼多多店铺 mall_sn→mall_id 解析缓存';

-- ── 3. 回填存量 mall_sn（只补空值）────────────────────────────────────────
-- mall_url 形如 mall_page.html?mall_sn=CgI2WR...%2B...%2F..&decrypt_mall_sn=1&msn=...
-- 先截到 mall_sn= 之后、再截到第一个 & 或 " 之前，最后把 %2B/%2F/%3D 还原成 +//=
-- ⚠ 必须先把 decrypt_mall_sn= 替换掉：它同样含 "mall_sn=" 子串且排在后面，
--   不处理的话 SUBSTRING_INDEX(..., -1) 取到的是 decrypt_mall_sn=1 的那个 "1"。
UPDATE `pdd_order`
   SET `mall_sn` = REPLACE(REPLACE(REPLACE(
         SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(
           REPLACE(`raw_json`, 'decrypt_mall_sn=', 'DEMSNX'), 'mall_sn=', -1), '&', 1), '"', 1),
         '%2B', '+'), '%2F', '/'), '%3D', '=')
 WHERE `mall_sn` IS NULL
   AND `raw_json` LIKE '%mall_sn=%';
