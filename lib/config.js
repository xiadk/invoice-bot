/**
 * lib/config.js — 应用配置读取（config.json）
 *
 * 为什么单独拆出来：
 *   原来 loadConfig 住在 lib/browser.js 里，而后者是 Playwright 浏览器会话模块——
 *   谁想读个配置，就被迫把「在服务器上起浏览器」这一整套依赖拖进来。
 *   云部署环境没有浏览器，这条依赖链迟早出事；拆开后读配置就是纯文件读取。
 *
 * 云端友好：找不到 config.json 时**不再 process.exit(1)**。
 *   云部署一般用 MYSQL_* 等环境变量配置（见 db.js 的 loadMysqlConfig），
 *   缺文件只警告一次并按默认值运行，而不是把整个服务拖死。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.APP_CONFIG_FILE
  ? path.resolve(process.env.APP_CONFIG_FILE)
  : path.join(ROOT, 'config.json');

let _warned = false;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[config] 读取 config.json 失败：' + String((e && e.message) || e));
  }
  if (!_warned) {
    _warned = true;
    console.warn('[config] 未找到 ' + CONFIG_PATH + '：按默认值运行。'
      + '云部署建议改用 MYSQL_* 等环境变量，或用 APP_CONFIG_FILE 指定挂载路径。');
  }
  return {};
}

module.exports = { loadConfig, CONFIG_PATH, ROOT };
