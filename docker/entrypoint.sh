#!/usr/bin/env bash
# docker/entrypoint.sh — invoice-bot 容器入口
#
# 做三件事：
#   1) 等数据库就绪（server.js 的建表在 listen 回调里且不重试，必须先确保库可连）
#   2) 准备 config.json（**仅作引导值**）：镜像内不打包它（含凭据，见 .dockerignore），
#      首次运行从 config.example.json 生成到数据卷，并用 APP_CONFIG_FILE 指过去。
#      v0.3.37 起业务配置存在数据库 app_config 表，看板「配置页」保存只写库，
#      因此这里不再要求 /app 可写、软链失败也不再阻断启动。
#   3) exec 启动服务（替换为 PID 1，优雅接收信号）
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

echo "[entrypoint] 1/3 等待数据库就绪 ..."
node scripts/wait-for-mysql.js

echo "[entrypoint] 2/3 准备 config.json（引导值）..."
mkdir -p "$APP_DIR/data" 2>/dev/null || true
if [ ! -f "$APP_DIR/data/config.json" ]; then
  if cp "$APP_DIR/config.example.json" "$APP_DIR/data/config.json" 2>/dev/null; then
    echo "[entrypoint]   已从 config.example.json 生成 data/config.json（仅首次引导，之后以数据库为准）"
  else
    echo "[entrypoint]   ⚠ 无法写入 $APP_DIR/data/config.json，将使用内置默认值启动"
    echo "     若使用绑定挂载（./data），请确保宿主目录对容器内用户可写：sudo chown -R 1000:1000 ./data"
  fi
fi
# 显式指向可写卷：不再依赖 /app/config.json 这个软链（只读层里建不了，老版本会直接 exit 1）
export APP_CONFIG_FILE="${APP_CONFIG_FILE:-$APP_DIR/data/config.json}"
echo "[entrypoint]   APP_CONFIG_FILE=$APP_CONFIG_FILE"
# 兼容仍在读 /app/config.json 的老代码/脚本；软链失败不再是启动失败
if [ ! -e "$APP_DIR/config.json" ]; then
  ln -sf "$APP_DIR/data/config.json" "$APP_DIR/config.json" 2>/dev/null \
    && echo "[entrypoint]   已建立软链 /app/config.json -> data/config.json" \
    || echo "[entrypoint]   ⚠ 无法建立 /app/config.json 软链（只读层），已用 APP_CONFIG_FILE 兜底"
fi

echo "[entrypoint] 3/3 启动服务（PORT=${PORT:-8787}）..."
exec node server.js
