FROM node:20-alpine

WORKDIR /app

# 零第三方运行时依赖：仅拷贝源码与页面
COPY package.json ./
COPY src ./src
COPY web ./web
COPY test ./test
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
