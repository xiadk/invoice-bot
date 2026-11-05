-- ═══════════════════════════════════════════════════════════════════════════
-- v0.3.37 业务配置入库：app_config 补建 + 说明
--
-- 【为什么需要】
--   系统管理里保存「拼多多 · 翻页上限」报「配置文件不可写（EACCES）：/app/config.json」。
--   根因不是权限配错，而是保存路径就是项目根的 config.json：容器镜像里 /app 属主是
--   root、进程以 node 运行（Dockerfile USER node），普通用户写不进去。
--   从本版本起，业务配置（runtime / messages / pddMessage / qiniu / server_url /
--   copyright）全部存 app_config 表，保存只写库，不再写任何文件；config.json 只在
--   「数据库里还没有该段」时作为引导值，并在服务启动时一次性搬进库。
--
-- 【表结构】
--   app_config 在 db.js 的 migrate() 里早已创建（退单定时同步在用），但 sql/schema.sql
--   一直漏建——全新部署靠 migrate 兜住，手工执行 schema.sql 的机器则会缺表。
--   本脚本补齐建表语句，并把含义写清：key = 'config.<段>'，value = JSON 文本。
--
-- 【执行】
--   mysql -u<user> -p <db> < sql/upgrade/0.3.37-业务配置入库.sql
--   （重启服务也会自动执行 db.js 里同一套建表，二者等效）
--
-- 【幂等】
--   CREATE TABLE IF NOT EXISTS，重复执行不改变任何已有数据；
--   不写任何初始值——迁移由服务启动时的 initConfigStore() 完成（只插入缺失键）。
--
-- 【回滚】
--   结构上无需回滚（多出来的表不影响旧版本）。若要退回「文件配置」口径：
--     DELETE FROM app_config WHERE `key` LIKE 'config.%';
--   删除后重启服务，配置重新从 config.json 读取，系统管理页会再次写文件。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS `app_config` (
  `key`        VARCHAR(64) NOT NULL        COMMENT '配置项（config.<段> 或业务自有键）',
  `value`      TEXT        DEFAULT NULL    COMMENT '配置值（JSON 文本或纯字符串）',
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='全局配置（业务配置与退单定时同步共用）';

-- 自检：应能看到 config.* 的键（首次启动服务后才会出现；老库此时可能为空，属正常）
-- SELECT `key`, LEFT(`value`, 60) AS preview, `updated_at` FROM app_config ORDER BY `key`;
