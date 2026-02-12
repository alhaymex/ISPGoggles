FROM oven/bun:1.1.29 AS base

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile || true

CMD ["bun", "start"]