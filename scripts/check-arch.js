#!/usr/bin/env node
/**
 * scripts/check-arch.js — 架构守卫（提交前必跑，退出码非 0 = 有违规）
 *
 * 守的是四条「一套」原则，防止新需求把系统拆成两套：
 *   R1 一套数据库配置 —— 只有 db.js 能解析 mysql 连接参数（json 的 mysql 段）
 *   R2 一套程序       —— 主进程禁用 child_process（electron/ 例外）；listen 只允许 server.js
 *   R3 一套页面       —— /api/qnh 只允许出现在 dashboard.html
 *   R4 无机器绑定     —— 源码里不许出现写死的用户目录（C:\Users\xxx、/home/xxx）
 *
 * 用法：node scripts/check-arch.js [--json]
 * 接入：invoice-bot-dev-workflow 技能的 Step 3（L1）+ Step 5 提交前
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'data', 'vendor', '.git', 'docker']);
const SCAN_DIRS = ['lib', 'electron', 'scripts', 'sql'];
const ROOT_EXT = new Set(['.js', '.html']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || path.basename(full).startsWith('tmp-')) continue;
      walk(full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (ROOT_EXT.has(ext) || ext === '.json') out.push(full);
    }
  }
  return out;
}

function collectFiles() {
  const files = [];
  let rootEntries = [];
  try { rootEntries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (e) { return files; }
  for (const e of rootEntries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ROOT_EXT.has(ext)) files.push(path.join(ROOT, e.name));
  }
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  return files.filter((f) => !path.basename(f).startsWith('tmp-') && !SKIP_FILES.has(rel(f)));
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const isComment = (line) => /^\s*(\/\/|\*|\/\*|#|<!--)/.test(line);

// 守卫脚本自身不参与扫描（含规则字面量，否则自我命中）
const SKIP_FILES = new Set(['scripts/check-arch.js']);

const RULES = [
  {
    id: 'R1',
    title: '一套数据库配置：mysql 段只允许 db.js 解析',
    check(files) {
      const bad = [];
      for (const f of files) {
        const r = rel(f);
        if (r === 'db.js' || !r.endsWith('.js')) continue;
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (isComment(line)) return;
          if (/\.mysql\b/.test(line)) {
            bad.push(`${r}:${i + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
      }
      return bad;
    },
  },
  {
    id: 'R2',
    title: '一套程序：主进程禁子进程（electron 打包侧例外），服务入口只在 server.js',
    check(files) {
      const bad = [];
      for (const f of files) {
        const r = rel(f);
        if (!r.endsWith('.js')) continue;
        const text = fs.readFileSync(f, 'utf8');
        const lines = text.split(/\r?\n/);
        // v0.2.4 起 Python 桥已移除：主进程任何地方都不允许 child_process，
        // 只有 electron/（桌面助手打包侧）保留例外
        const allowProc = r.startsWith('electron/');
        const allowListen = r === 'server.js';
        lines.forEach((line, i) => {
          if (isComment(line)) return;
          if (!allowProc && /require\((['"])child_process\1\)/.test(line)
              && !line.includes('arch-allow: child_process')) {
            bad.push(`${r}:${i + 1}  引入 child_process（同步已迁入 lib/qnh-sync.js，electron/ 之外不允许子进程；` +
              `确需豁免在该行尾加注释标记 arch-allow: child_process 并说明用途）`);
          }
          if (!allowListen && /\.listen\s*\(/.test(line) && !/\.on\(/.test(line)) {
            bad.push(`${r}:${i + 1}  启动监听（只允许 server.js 一个服务入口）`);
          }
        });
      }
      return bad;
    },
  },
  {
    id: 'R3',
    title: '一套页面：/api/qnh 只出现在 dashboard.html',
    check(files) {
      const bad = [];
      for (const f of files) {
        const r = rel(f);
        if (!r.endsWith('.html') || r === 'dashboard.html') continue;
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/\/api\/qnh\//.test(line)) bad.push(`${r}:${i + 1}  退单接口调用（应并入 dashboard.html 的退单列表页）`);
        });
      }
      return bad;
    },
  },
  {
    id: 'R4',
    title: '无机器绑定：源码不写死用户目录',
    check(files) {
      const bad = [];
      // 同时覆盖 JS 字符串里的双反斜杠（'C:\\Users\\x'）与单反斜杠 / 正斜杠写法
      const WIN_HOME = /['"`][^'"`]*[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9_.-]/i;
      const NIX_HOME = /['"`][^'"`]*\/home\/[A-Za-z0-9_.-]+\//;
      for (const f of files) {
        const r = rel(f);
        if (!/\.(js|json|html)$/.test(r)) continue;
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (isComment(line)) return;
          if (WIN_HOME.test(line) || NIX_HOME.test(line)) {
            bad.push(`${r}:${i + 1}  写死用户目录：${line.trim().slice(0, 80)}`);
          }
        });
      }
      return bad;
    },
  },
  {
    id: 'R5',
    title: '一套程序清单：根目录之外不允许第二个 package.json',
    check() {
      const bad = [];
      for (const d of ['lib', 'electron', 'scripts', 'sql']) {
        const p = path.join(ROOT, d, 'package.json');
        if (fs.existsSync(p)) bad.push(`${d}/package.json  出现第二套依赖清单（应并入根 package.json）`);
      }
      return bad;
    },
  },
  {
    id: 'R6',
    title: '一套建表语句：CREATE TABLE 只在 db.js 或 sql/',
    check(files) {
      const bad = [];
      for (const f of files) {
        const r = rel(f);
        if (!r.endsWith('.js')) continue;
        if (r === 'db.js') continue;
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/CREATE\s+TABLE/i.test(line)) bad.push(`${r}:${i + 1}  建表语句（DDL 统一放 db.js / sql）`);
        });
      }
      return bad;
    },
  },
];

function main() {
  const json = process.argv.includes('--json');
  const files = collectFiles();
  const results = RULES.map((r) => ({ id: r.id, title: r.title, bad: r.check(files) }));
  const failed = results.filter((r) => r.bad.length);

  if (json) {
    console.log(JSON.stringify({ checked: files.length, results }, null, 2));
    process.exit(failed.length ? 1 : 0);
  }

  console.log(`架构守卫 · invoice-bot（扫描 ${files.length} 个文件）`);
  for (const r of results) {
    if (!r.bad.length) {
      console.log(`  ✓ ${r.id} ${r.title}`);
    } else {
      console.log(`  ✗ ${r.id} ${r.title}（${r.bad.length} 处）`);
      for (const b of r.bad) console.log(`      ${b}`);
    }
  }
  console.log(`\n结果：${results.length - failed.length} 项通过 / ${failed.length} 项违规`);
  process.exit(failed.length ? 1 : 0);
}

main();
