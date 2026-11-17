-- ============================================================================
-- 定时任务日志表（2026-11-17）
--
-- 用途：退单同步 / 实时毛利监控两个定时器的每次决策与结果落库，
--       让「定时任务到底跑没跑、为什么没跑」在看板监控卡片里直接可查，
--       不用再翻 docker logs。
--
-- 执行方式（二选一，等效）：
--   1) 重启服务：db.js 的 migrate() 里 ensureQnhSchema() 会自动建表（CREATE TABLE IF NOT EXISTS）
--   2) 手工执行：mysql -h<host> -uroot -p invoice_bot < sql/upgrade/2026-11-17-定时任务日志表.sql
--
-- 幂等：CREATE TABLE IF NOT EXISTS，重复执行不报错、不丢数据。
-- 回滚：DROP TABLE IF EXISTS `qnh_task_log`;（仅删除日志表，不影响业务数据）
-- ============================================================================

CREATE TABLE IF NOT EXISTS `qnh_task_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL DEFAULT 0 COMMENT '任务归属用户（0=全局）',
  `task_type` VARCHAR(16) NOT NULL COMMENT '任务类型：refund=退单同步 / profit=毛利拉取',
  `trigger` VARCHAR(16) NOT NULL DEFAULT 'schedule' COMMENT '触发方式：schedule=定时 / manual=手动 / retry=解锁重跑',
  `status` VARCHAR(16) NOT NULL COMMENT '结果：ok=成功 / fail=失败 / skip=跳过',
  `rows` INT NOT NULL DEFAULT 0 COMMENT '处理条数（退单数 / 毛利明细行数）',
  `message` VARCHAR(512) DEFAULT NULL COMMENT '结果说明 / 跳过或失败原因',
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_qtl_type_time` (`task_type`, `started_at`),
  KEY `idx_qtl_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花定时任务日志';
