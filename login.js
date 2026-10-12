/**
 * login.js — 首次登录并保存登录态
 *
 * 用法: node login.js
 * 浏览器打开后手动完成登录（扫码或账密），脚本检测到登录成功后自动保存登录态。
 * 之后 invoice.js / probe.js 复用登录态，无需重复登录。
 */
const { launch, saveState, isLoggedIn, waitHuman } = require('./lib/browser');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { browser, context, config } = await launch();
  const page = await context.newPage();

  const loginUrl = config.platforms['1688'].loginUrl;
  console.log(`打开登录页: ${loginUrl}`);
  await page.goto(loginUrl);

  // 等人工完成登录（扫码/账密/验证码都由人来，脚本不碰）
  await waitHuman('请在浏览器中完成 1688 登录（扫码或账号密码）');

  // 回到工作台验证登录态
  await page.goto('https://work.1688.com/home/page/index.htm');
  await page.waitForLoadState('domcontentloaded');
  await sleep(3000);

  if (!isLoggedIn(page)) {
    console.error('[fail] 仍检测到未登录（页面跳回了登录页）。请重新运行 node login.js');
    await browser.close();
    process.exit(1);
  }

  await saveState(context);
  console.log('[done] 登录成功，登录态已持久化。下次运行抓取脚本无需再登录（一般可维持数天~数周，失效后重跑本脚本）。');

  await browser.close();
})().catch((e) => {
  console.error('登录流程出错:', e);
  process.exit(1);
});
