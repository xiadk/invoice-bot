#!/usr/bin/env node
/**
 * 构建前写入「代码版本指纹」→ 根目录 build-info.json（不入库，见 .gitignore）
 *
 * 为什么需要：Docker 镜像里没有 .git（被 .dockerignore 排除），容器跑起来后
 * 无法自证「我跑的是哪个提交」。出现过一次典型事故：本地早已修掉的限制
 * （退单同步仅超级管理员可触发），线上容器还在跑旧镜像，用户一直看到旧报错。
 *
 * 有了这个文件，看板「系统管理」页顶部会显示线上实际运行的分支@提交与时间，
 * 一眼就能判断是不是该重新发版。
 *
 * 用法：npm run docker:build / npm run docker:rebuild（脚本会自动先跑本文件）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build-info.json');

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
}

let info = null;
try {
  info = {
    commit: git(['rev-parse', '--short', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    time: git(['log', '-1', '--format=%cI']),
    subject: git(['log', '-1', '--format=%s']),
    dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length > 0,
    builtAt: new Date().toISOString(),
  };
} catch (e) {
  // 不是 git 工作副本（例如服务器上直接解压部署）：宁可不写，也不要留一份旧指纹误导人
  try { fs.unlinkSync(OUT); } catch (_) { /* 本来就没有 */ }
  console.warn('[build-info] 读取 git 信息失败，已移除旧的 build-info.json：' + (e.message || e));
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n');
console.log(`[build-info] ${info.branch}@${info.commit} ${info.time}${info.dirty ? ' (有未提交改动)' : ''}`);
console.log(`[build-info] 最近提交：${info.subject}`);
