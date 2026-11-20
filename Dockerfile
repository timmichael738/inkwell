# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
ENV DATABASE_PATH=/app/data/inkwell.db
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4100/api/health || exit 1
CMD ["node", "dist/server/src/main.js"]
