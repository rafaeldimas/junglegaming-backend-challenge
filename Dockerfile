# syntax=docker/dockerfile:1

# --- dependencies ---------------------------------------------------------
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- build ----------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN bun run build

# --- runtime --------------------------------------------------------------
FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Compiled app plus the compiled migration files (the migrator loads them at
# runtime, both for the app and for the one-shot migration service).
COPY --from=build /app/dist ./dist

USER bun
EXPOSE 3000

CMD ["bun", "run", "dist/main.js"]
