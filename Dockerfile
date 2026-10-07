# 零依赖 Node 运行镜像：仅需 Node 20+，无需 npm install
FROM node:20-alpine

WORKDIR /app

# 先拷贝清单与源码（无第三方依赖，无需 npm install）
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# 构建页面产物到 dist/（服务端优先使用 dist，回退 public）
RUN node scripts/build.mjs

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

EXPOSE 8080

# 简单健康检查（容器运行期）
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
