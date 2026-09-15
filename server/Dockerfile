FROM oven/bun:1.4.2

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY src ./src

ENV PORT=8090
EXPOSE 8090

CMD ["bun", "run", "src/server.ts"]
