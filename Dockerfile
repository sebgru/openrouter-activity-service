FROM node:22-alpine AS build
WORKDIR /app
COPY server.mjs .

FROM node:22-alpine
# Upgrade all packages to pick up latest security patches.
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*
# Remove npm and its bundled deps — not needed at runtime, avoids Trivy false positives.
RUN rm -rf /usr/local/lib/node_modules/npm
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/server.mjs .
# Default port 8767 — override via OPENROUTER_ACTIVITY_PORT env var.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('http').get({hostname:'127.0.0.1',port:+(process.env.OPENROUTER_ACTIVITY_PORT||8767),path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "server.mjs"]
