-- 0.3.24 拼多多订单：新增 note 本地说明列 + 「交易成功且未同步开票」归入暂不可开票
-- 用途：
--   1) pdd_order 加 note 列（本地说明备注，区别于平台返回的 reject_reason）
--   2) 存量口径回填：invoice_status=9（未同步开票，发票接口从没返回过）且 order_status=4
--      （交易成功）的单 → invoice_status=0（暂不可开票），note='订单超时没有申请入口'。
--      这类单平台开票入口已关、催收入口也不再显示（2026-11-04 用户定稿口径）。
-- 执行：node server.js 启动时 migrate() 会自动执行；也可手动对本库执行本文件。
-- 回滚：ALTER TABLE `pdd_order` DROP COLUMN `note`;
--       UPDATE `pdd_order` SET `invoice_status` = 9
--        WHERE `note` = '订单超时没有申请入口' AND `invoice_status` = 0;
--       （回滚会把后续发票接口写入的真实状态一并误伤，回滚前先备份）

ALTER TABLE `pdd_order`
  ADD COLUMN IF NOT EXISTS `note` VARCHAR(255) DEFAULT NULL
  COMMENT '本地说明备注（订单超时没有申请入口/申请失败原因/无法开启聊天，线下处理）';

UPDATE `pdd_order`
   SET `invoice_status` = 0,
       `note` = '订单超时没有申请入口'
 WHERE `invoice_status` = 9
   AND `order_status` = 4
   AND (`note` IS NULL OR `note` = '');
