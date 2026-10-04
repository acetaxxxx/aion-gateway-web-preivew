FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    PREVIEW_SCAN_ROOT=/aion-data/conversations/users \
    GATEWAY_DATA_DIR=/gateway-data

WORKDIR /app
RUN mkdir -p /gateway-data && chown node:node /gateway-data
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.mjs"]
