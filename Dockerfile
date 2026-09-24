FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    wget \
    ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./

RUN npm install

COPY src ./src

RUN npm run build


FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PYTHON_BIN=/app/.venv/bin/python
ENV ML_DIR=/app/ml
ENV LOG_DIR=/app/logs

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    wget \
    ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

COPY ml ./ml

RUN python3 -m venv /app/.venv

RUN /app/.venv/bin/pip install --upgrade pip \
  && /app/.venv/bin/pip install \
    numpy \
    scikit-learn \
    joblib

RUN mkdir -p /app/logs

EXPOSE 3007

CMD ["node", "dist/server.js"]
