FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CLONE_AI_DATA_DIR=/data \
    CLONE_AI_WORKSPACE=/workspace \
    CLONE_AI_PORT=4317 \
    CLONE_AI_WHATSAPP_PORT=4318 \
    CLONE_AI_WHATSAPP_HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=768

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY apps/desktop/ui ./apps/desktop/ui

RUN mkdir -p /data /workspace && chown -R node:node /app /data /workspace
USER node

EXPOSE 4317 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CLONE_AI_PORT||4317)+'/api/health',{headers:{'x-clone-proxy-secret':process.env.CLONE_AI_PROXY_SECRET||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/server-main.ts"]
