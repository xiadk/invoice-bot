# syntax=docker/dockerfile:1
# ============================================================================
# invoice-bot 镜像 —— 发票催收控制台（云端部署）
#
# 架构说明（2026-10-13 起）：
#   服务端不保存 1688 登录态、不启动服务端浏览器；发送在用户本机浏览器扩展里执行。
#   因此本镜像**不需要** Chromium 及其中文/无头依赖，playwright 仅作为遗留代码
#   （lib/browser.js 的 launch()，已无调用方）的依赖保留，构建时跳过浏览器下载。
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
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# 先拷贝依赖清单再 npm ci：node_modules 不变时命中层缓存，不用每次重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
