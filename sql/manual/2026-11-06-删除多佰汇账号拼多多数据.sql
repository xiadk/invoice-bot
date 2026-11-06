-- ============================================================================
-- 删除「深圳市多佰汇商贸有限公司」**账号**下已存在的拼多多订单及全部关联数据
-- 用途：清空后重新拉取（账号本身保留，不删 app_user）
-- 生成日期：2026-11-06
-- ============================================================================
-- 【执行前必读】
--   1) 这是「按账号清空」脚本，不是「按店铺删」。删的是该账号归属下
--      **全部**拼多多数据：订单、店铺解析缓存、人工催收汇总、开票申请记录、
--      催收消息记录。1688/闪电帮帮/牵牛花/商品/补货等其它业务数据一律不动。
--   2) 本机 development 库查不到这个账号（只有 admin / 中山仕赫贸易有限公司 /
--      雷远琼），说明目标在线上库。请先连对库，再跑「第 0 步」，确认
--      @hit_user/@hit_company 结果、@uid 有值、各表行数符合预期，才继续。
--   3) 定位规则：**先按 username 精确匹配**（账号名就是登录名，唯一）；
--      username 命中 0 个时，才退化到 company_full_name / company_name 兜底。
--      不能一上来就按公司名匹配 —— 员工账号抄的也是主体公司名，按公司名会
--      一次命中「主体 + 若干员工」（隔离库已实测复现）。
--   4) 安全闸：命中 0 个或多个时，@uid 自动变成 NULL，后面所有
--      DELETE 都是空操作（user_id = NULL 永不成立），不会误删。
--      命中多个时，把 @acct_id_manual 填成目标账号 id 再重跑。
--   5) 员工账号（owner_id > 0）的拼多多数据实际记在**主体账号**名下，
--      脚本会自动换算到主体 uid。若目标账号是员工，删的就是整个主体的
--      拼多多数据（含同主体其它员工），第 0 步会打印出来，请确认后再执行。
--   6) pdd_session 是拼多多登录 Cookie，默认**不删**（删了要重新扫码登录，
--      否则重拉会失败）。确实要一起清，见第 2.6 段（默认注释）。
-- ============================================================================


-- ── 参数 ────────────────────────────────────────────────────────────────────
-- 账号名：优先当 username（登录名）用；匹配不到才当公司名用。
-- 显式 COLLATE：本库 app_user 是 utf8mb4_general_ci、pdd_order 是 utf8mb4_unicode_ci，
-- 有的客户端连接 collation 又是别的，不写死会在 `username = @acct` 上直接报
-- 「Illegal mix of collations」中止。这里两侧统一成 utf8mb4_general_ci。
SET @acct := CONVERT('深圳市多佰汇商贸有限公司' USING utf8mb4) COLLATE utf8mb4_general_ci;
SET @acct_id_manual  := 0;                          -- 人工指定账号 id；0 = 自动按名字匹配

-- ── 定位（自动） ────────────────────────────────────────────────────────────
-- 1) username 精确命中数（首选口径）
SET @hit_user := (SELECT COUNT(*) FROM app_user
                   WHERE CONVERT(username USING utf8mb4) COLLATE utf8mb4_general_ci = @acct);

-- 2) 公司名命中数（兜底口径）
SET @hit_company := (SELECT COUNT(*) FROM app_user
                      WHERE CONVERT(company_full_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
                         OR CONVERT(company_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct);

-- 3) 择优：username 唯一就用它；username 为 0 且公司名唯一才兜底；其余一律 NULL（停手）
SET @acct_id_auto := CASE
    WHEN @hit_user = 1 THEN
      (SELECT MIN(id) FROM app_user
        WHERE CONVERT(username USING utf8mb4) COLLATE utf8mb4_general_ci = @acct)
    WHEN @hit_user = 0 AND @hit_company = 1 THEN
      (SELECT MIN(id) FROM app_user
        WHERE CONVERT(company_full_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
           OR CONVERT(company_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct)
    ELSE NULL END;

SET @acct_id := IF(@acct_id_manual > 0, @acct_id_manual, @acct_id_auto);

-- 数据归属 uid：员工账号 → owner_id；普通账号 → 自己
SET @uid := IF(@acct_id IS NULL, NULL,
               (SELECT IF(COALESCE(owner_id, 0) > 0, owner_id, id)
                  FROM app_user WHERE id = @acct_id));

-- 是否员工号（1 = 是，删的是主体全量数据，需要额外确认）
SET @is_staff := IF(@uid IS NULL, NULL,
                    (SELECT IF(id <> @uid, 1, 0) FROM app_user WHERE id = @acct_id));


-- ============================================================================
-- 第 0 步：定位与盘点（只读，先看清楚要删什么）
-- ============================================================================

-- 0.1 账号定位结果（status 必须是 ✅）
SELECT @acct AS account_input,
       @hit_user AS username_hits, @hit_company AS company_hits,
       @acct_id AS account_id, @uid AS data_owner_uid,
       CASE WHEN @acct_id IS NULL AND @hit_user > 1
              THEN '❌ username 命中多个账号，请把 @acct_id_manual 填成目标 id'
            WHEN @acct_id IS NULL AND @hit_user = 0 AND @hit_company = 0
              THEN '❌ 找不到这个账号，脚本不会删任何数据'
            WHEN @acct_id IS NULL AND @hit_company > 1
              THEN '❌ 公司名命中多个账号（主体+员工），请改用 username 或填 @acct_id_manual'
            WHEN @uid IS NULL THEN '❌ 账号 id 解析失败'
            WHEN @is_staff = 1 THEN CONCAT('⚠ 该账号是员工号，将清空主体账号 ', @uid, ' 的全部拼多多数据')
            WHEN @hit_user = 0 THEN '✅ 定位成功（按公司名兜底命中）'
            ELSE '✅ 定位成功' END AS status;

-- 0.2 命中的账号明细（优先级：username 命中 > 公司名命中）
SELECT id, username, role, status,
       company_full_name, company_name,
       owner_id, pdd_enabled, expires_at, created_at,
       CASE WHEN CONVERT(username USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
            THEN 'username 命中' ELSE '公司名命中' END AS hit_by
  FROM app_user
 WHERE CONVERT(username USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
    OR CONVERT(company_full_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
    OR CONVERT(company_name USING utf8mb4) COLLATE utf8mb4_general_ci = @acct
 ORDER BY (CONVERT(username USING utf8mb4) COLLATE utf8mb4_general_ci = @acct) DESC, id;

-- 0.3 该主体下的全部账号（员工共享主体数据，删主体 = 全部员工都没了）
SELECT id, username, role, owner_id,
       IF(id = @uid, '← 数据归属主体', '') AS flag
  FROM app_user
 WHERE id = @uid
    OR owner_id = @uid
 ORDER BY id;

-- 0.4 待删数据总览（行数 / 金额 / 时间范围）
SELECT 'pdd_order' AS tbl, COUNT(*) AS rows_to_delete,
       SUM(pay_amount) AS amount, MIN(order_time) AS first_at, MAX(order_time) AS last_at
  FROM pdd_order WHERE user_id = @uid
UNION ALL
SELECT 'pdd_mall', COUNT(*), NULL, NULL, MAX(tried_at)
  FROM pdd_mall WHERE user_id = @uid
UNION ALL
SELECT 'pdd_collect_summary', COUNT(*), SUM(amount), NULL, MAX(updated_at)
  FROM pdd_collect_summary WHERE user_id = @uid
UNION ALL
SELECT 'pdd_apply_log', COUNT(*), NULL, MIN(created_at), MAX(created_at)
  FROM pdd_apply_log WHERE user_id = @uid
UNION ALL
SELECT 'pdd_msg_log', COUNT(*), NULL, MIN(created_at), MAX(created_at)
  FROM pdd_msg_log WHERE user_id = @uid;

-- 0.5 订单样例（核对是不是想清的那批；删完这些会重新同步回来）
SELECT order_sn, mall_name, mall_id, order_time, pay_amount, invoice_status,
       order_status_text
  FROM pdd_order
 WHERE user_id = @uid
 ORDER BY order_time DESC
 LIMIT 20;

-- 0.6 该账号有无拼多多登录态（有的话重拉可以直接同步；脚本默认保留）
SELECT user_id, account_name, pdduid, cookie_count, agent_ver, updated_at
  FROM pdd_session WHERE user_id = @uid;


-- ============================================================================
-- 第 1 步：备份（整账号全量备份；确认重拉正常后再 DROP 这些 bak 表）
--   ⚠ 表名固定：若同名表已存在会报错中止（这是有意的，避免覆盖上一次的备份）。
--      重复执行时先把旧备份改名，例如：
--      RENAME TABLE bak_duobaihui_acct_pdd_order TO bak_duobaihui_acct_pdd_order_old;
-- ============================================================================
CREATE TABLE bak_duobaihui_acct_pdd_order AS
SELECT * FROM pdd_order WHERE user_id = @uid;

CREATE TABLE bak_duobaihui_acct_pdd_mall AS
SELECT * FROM pdd_mall WHERE user_id = @uid;

CREATE TABLE bak_duobaihui_acct_pdd_collect_summary AS
SELECT * FROM pdd_collect_summary WHERE user_id = @uid;

CREATE TABLE bak_duobaihui_acct_pdd_apply_log AS
SELECT * FROM pdd_apply_log WHERE user_id = @uid;

CREATE TABLE bak_duobaihui_acct_pdd_msg_log AS
SELECT * FROM pdd_msg_log WHERE user_id = @uid;

-- 备份完整性校验：应与第 0.4 步的数字一致
SELECT 'bak_pdd_order' AS bak, COUNT(*) AS n FROM bak_duobaihui_acct_pdd_order
UNION ALL SELECT 'bak_pdd_mall', COUNT(*) FROM bak_duobaihui_acct_pdd_mall
UNION ALL SELECT 'bak_pdd_collect_summary', COUNT(*) FROM bak_duobaihui_acct_pdd_collect_summary
UNION ALL SELECT 'bak_pdd_apply_log', COUNT(*) FROM bak_duobaihui_acct_pdd_apply_log
UNION ALL SELECT 'bak_pdd_msg_log', COUNT(*) FROM bak_duobaihui_acct_pdd_msg_log;


-- ============================================================================
-- 第 2 步：删除（同一事务；先删引用订单的日志，再删汇总/店铺缓存，最后删订单）
-- ============================================================================
START TRANSACTION;

-- 2.1 开票申请记录 / 催收消息记录
DELETE FROM pdd_apply_log WHERE user_id = @uid;
DELETE FROM pdd_msg_log   WHERE user_id = @uid;

-- 2.2 人工催收汇总（下次打开催收页或同步结束后会按新订单自动重建）
DELETE FROM pdd_collect_summary WHERE user_id = @uid;

-- 2.3 店铺 mall_sn → mall_id 解析缓存（删掉后重新同步会重新解析）
DELETE FROM pdd_mall WHERE user_id = @uid;

-- 2.4 订单本体（最后删）
DELETE FROM pdd_order WHERE user_id = @uid;

-- 2.5 操作日志里的拼多多动作（审计用，默认**保留**；要清就取消下一行注释）
-- DELETE FROM operation_log WHERE user_id = @uid AND action LIKE 'pdd.%';

-- 2.6 拼多多登录态（默认**保留**，否则重拉要重新扫码登录；确认要清再取消注释）
-- DELETE FROM pdd_session WHERE user_id = @uid;

-- 核对第 3 步数字为 0、且第 0 步行数对得上，再执行 COMMIT; 不一致就 ROLLBACK;
COMMIT;


-- ============================================================================
-- 第 3 步：校验（remaining 全部应为 0）
-- ============================================================================
SELECT 'pdd_order' AS tbl, COUNT(*) AS remaining FROM pdd_order WHERE user_id = @uid
UNION ALL SELECT 'pdd_mall', COUNT(*) FROM pdd_mall WHERE user_id = @uid
UNION ALL SELECT 'pdd_collect_summary', COUNT(*) FROM pdd_collect_summary WHERE user_id = @uid
UNION ALL SELECT 'pdd_apply_log', COUNT(*) FROM pdd_apply_log WHERE user_id = @uid
UNION ALL SELECT 'pdd_msg_log', COUNT(*) FROM pdd_msg_log WHERE user_id = @uid;

-- 账号本身必须还在（本脚本绝不碰 app_user）
SELECT id, username, company_full_name, owner_id FROM app_user WHERE id = @acct_id;


-- ============================================================================
-- 第 4 步：重新拉取（SQL 之外的操作）
--   1. 用该账号登录 → 打开「拼多多发票」页 → 点「同步」（订单 + 发票状态一起重拉）；
--      或等定时同步到点。同步按时间窗口拉取，删掉的订单会重新入库。
--   2. 同步完成后打开「拼多多人工催收」页点一次「刷新」，
--      pdd_collect_summary 会按新订单自动重建（重建是「先删后插」，幂等）。
--   3. 全部确认无误后再清理备份：
--      DROP TABLE bak_duobaihui_acct_pdd_order, bak_duobaihui_acct_pdd_mall,
--                 bak_duobaihui_acct_pdd_collect_summary,
--                 bak_duobaihui_acct_pdd_apply_log, bak_duobaihui_acct_pdd_msg_log;
-- ============================================================================

-- 【回滚】重拉失败想把数据原样还回来（先确认目标表当下没有同单号记录，否则会主键冲突）：
--   INSERT INTO pdd_order            SELECT * FROM bak_duobaihui_acct_pdd_order;
--   INSERT INTO pdd_mall             SELECT * FROM bak_duobaihui_acct_pdd_mall;
--   INSERT INTO pdd_collect_summary  SELECT * FROM bak_duobaihui_acct_pdd_collect_summary;
--   INSERT INTO pdd_apply_log        SELECT * FROM bak_duobaihui_acct_pdd_apply_log;
--   INSERT INTO pdd_msg_log          SELECT * FROM bak_duobaihui_acct_pdd_msg_log;
--   回滚后也建议在看板点一次「刷新」，让汇总表按恢复后的订单重算。
