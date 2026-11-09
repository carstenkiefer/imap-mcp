# Multi-arch (amd64, arm64, arm/v7): the official Node image covers all of them,
# and imap-mcp has no native modules.
FROM node:22-alpine

ENV NODE_ENV=production \
    IMAP_MCP_CONFIG=/config/config.json \
    XDG_STATE_HOME=/data \
    IMAP_MCP_HTTP_HOST=0.0.0.0 \
    IMAP_MCP_HTTP_PORT=8808

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src

RUN mkdir -p /data /config && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8808

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8808/health || exit 1

ENTRYPOINT ["node", "bin/imap-mcp.js"]
CMD ["http"]
