FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./

RUN npm install

COPY src ./src

RUN npm run build


FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Обновить SSL сертификаты
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3007

CMD ["node", "dist/server.js"]
