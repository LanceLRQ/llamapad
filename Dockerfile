# syntax=docker/dockerfile:1

# ---------- deps：npm ci + better-sqlite3 原生编译 ----------
FROM node:22-bookworm-slim AS deps
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ENV http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci && node -e "new (require('better-sqlite3'))(':memory:')"

# ---------- build：next build（standalone 产物） ----------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build \
 && node -e "require('fs').accessSync('.next/standalone/node_modules/better-sqlite3/prebuilds/linux-x64.node')" \
 && echo "trace check: better-sqlite3 prebuilds in standalone OK"

# ---------- runtime：非 root 精简运行时 ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=28960 TZ=Asia/Shanghai
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# serverExternalPackages（better-sqlite3/dockerode/ssh2）外置包兜底：
# trace 已含则幂等覆盖；若 trace 缺传递依赖，按冒烟报错包名在此增补 COPY 行
# （ssh2 1.17 已内置 ssh2-streams，无需单独兜底）
COPY --from=deps /app/node_modules/dockerode ./node_modules/dockerode
COPY --from=deps /app/node_modules/docker-modem ./node_modules/docker-modem
COPY --from=deps /app/node_modules/ssh2 ./node_modules/ssh2
RUN mkdir -p /app/config && chown -R node:node /app
USER node
EXPOSE 28960
CMD ["node", "server.js"]
