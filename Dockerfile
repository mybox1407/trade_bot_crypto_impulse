FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build


FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV LOG_DIR=/app/logs

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/logs

EXPOSE 3007

CMD ["node", "dist/server.js"]
