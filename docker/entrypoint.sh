#!/usr/bin/env bash
# docker/entrypoint.sh — invoice-bot 容器入口
#
# 做三件事：
#   1) 等数据库就绪（server.js 的建表在 listen 回调里且不重试，必须先确保库可连）
#   2) 准备 config.json：镜像内不打包它（含凭据，见 .dockerignore）；
#      首次运行从 config.example.json 生成到数据卷，并软链到代码读取的位置，
#      这样看板「配置页」的改动能跨容器重建保留
#   3) exec 启动服务（替换为 PID 1，优雅接收信号）
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

echo "[entrypoint] 1/3 等待数据库就绪 ..."
node scripts/wait-for-mysql.js

echo "[entrypoint] 2/3 准备 config.json ..."
if [ ! -f "$APP_DIR/data/config.json" ]; then
  if ! cp "$APP_DIR/config.example.json" "$APP_DIR/data/config.json"; then
    echo "[entrypoint] ✗ 无法写入 $APP_DIR/data/config.json" >&2
    echo "  若使用绑定挂载（./data），请确保宿主目录对容器内用户可写：" >&2
    echo "    Linux/macOS: sudo chown -R 1000:1000 ./data" >&2
    exit 1
  fi
  echo "[entrypoint]   已从 config.example.json 生成 data/config.json（可在看板「配置」页修改，改动持久化在数据卷）"
fi
if [ ! -L "$APP_DIR/config.json" ]; then
  if ! ln -sf "$APP_DIR/data/config.json" "$APP_DIR/config.json"; then
    echo "[entrypoint] ✗ 无法创建软链 $APP_DIR/config.json -> data/config.json" >&2
    exit 1
  fi
fi

echo "[entrypoint] 3/3 启动服务（PORT=${PORT:-8787}）..."
exec node server.js
