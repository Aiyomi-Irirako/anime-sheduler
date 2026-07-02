FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine

ENV NODE_ENV=production
ENV WEB_PORT=3000
ENV DATA_FILE=/app/data/db.json

WORKDIR /app

RUN corepack enable && mkdir -p /app/data && chown -R node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json pnpm-lock.yaml ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
