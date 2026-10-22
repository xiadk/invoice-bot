# syntax=docker/dockerfile:1
# ============================================================================
# invoice-bot 镜像 —— 发票催收控制台（云端部署）
#
# 架构说明（2026-10-22 起）：
#   服务器**完全不碰浏览器**：
#     · 1688 催收消息 → 由用户本机的「1688 催收助手」发送
#     · 牵牛花登录   → 由用户本机的「1688 催收助手」弹窗登录后回传登录态（存 MySQL）
#     · 退单数据     → 服务器拿着登录态直接调牵牛花 HTTP 接口
#   因此本镜像既不需要 Chromium 也不需要 Playwright：
#     · 依赖安装用 --omit=optional（playwright 已移到 optionalDependencies）
#     · QNH_PAGE_ENABLED=0 显式关掉「常驻浏览器旁路」，避免它在无显示器环境空转
#   ⚠ 登录态存数据库（qnh_session 表），容器重启/扩缩容都不丢；
#     千万别再改成写 data/qnh-state.json——容器一重启就全没了。
#
# 构建：docker build -t invoice-bot .
# 运行：docker compose up -d   （见 docker-compose.yml，自带 MariaDB）
# ============================================================================
FROM node:22-slim

# tzdata：让 TZ 环境变量生效；ca-certificates：HTTPS 外链
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    TZ=Asia/Shanghai \
    QNH_PAGE_ENABLED=0 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# 先拷贝依赖清单再 npm ci：node_modules 不变时命中层缓存，不用每次重装。
# --omit=dev --omit=optional：云端不装 electron / playwright（都不需要）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# 应用代码。config.json 已被 .dockerignore 排除（含凭据），入口脚本会从
# config.example.json 生成；data/ 下的真实数据同样不入镜像（挂数据卷）。
COPY . .

# 数据目录 = 数据卷挂载点。先建好并属主 node，命名卷首次创建时继承该属主，
# 否则容器内 node 用户写不进去（entrypoint 的 config.json 引导会失败）。
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 8787

# 健康检查：/api/auth/me 未登录时返回 401，只要有 HTTP 响应即视为进程健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/auth/me',r=>process.exit(r.statusCode?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["bash", "/app/docker/entrypoint.sh"]
