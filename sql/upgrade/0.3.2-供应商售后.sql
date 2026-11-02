-- ============================================================================
-- 0.3.2 供应商售后 —— 售后管理菜单整页替换为「针对供应商的售后」
-- ============================================================================
-- 用途：
--   1) 新建 supplier_after（供应商售后台账：供应商 + 内容 + 金额 + 售后日期 + 状态 + 凭证）
--   2) 凭证图继续复用 qnh_after_attach（row_key 新增 sup:<id> 格式），该表 v0.2.108 已建，无需变更
--
-- 执行（任选其一）：
--   · 直接重启服务（db.js migrate() 会执行同一套幂等逻辑，推荐）
--   · 手工执行：mysql -u<user> -p <database> < sql/upgrade/0.3.2-供应商售后.sql
--
-- 回滚（一般不需要 —— 只加新表，不动旧数据）：
--   DROP TABLE IF EXISTS `supplier_after`;
--   （旧数据从未迁移：qnh_after_manual / qnh_refund_order 售后列 / qnh_after_attach
--     的 ref:/man: 凭证全部原样保留，回滚后把前端切回旧版即可继续使用）
-- ============================================================================

CREATE TABLE IF NOT EXISTS `supplier_after` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id，0=供应商已被删）',
  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '登记时的供应商名称快照（兜底展示）',
  `goods_desc`    VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '售后内容（商品/事由文字描述）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '售后金额（元）',
  `after_date`    DATE          NOT NULL             COMMENT '售后日期（按此列查询与排序）',
  `status`        TINYINT       NOT NULL DEFAULT 0   COMMENT '处理状态：0待处理 1已申请 2已退货 3已退款（人工推进，一键下一档）',
  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注',
  `handled_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人（登录账号）',
  `handled_at`    DATETIME      DEFAULT NULL         COMMENT '最后处理时间',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sa_user_date`   (`user_id`, `after_date`),
  KEY `idx_sa_user_sup`    (`user_id`, `supplier_id`),
  KEY `idx_sa_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='供应商售后台账（供应商 + 内容 + 金额 + 售后日期 + 凭证）';
