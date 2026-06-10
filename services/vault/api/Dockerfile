# Baku API — local dev image with hot reload.
#
# The source tree is bind-mounted at runtime (see docker-compose.yml), so
# this image only needs Bun + installed deps. `bun --watch` restarts the
# process on file change.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Install deps based on the lockfile only. The actual source is bind-mounted
# at runtime, but we still need node_modules baked in so the container has
# something to fall back to before the host bind mount lands.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source for the initial image build. At runtime the bind mount from
# docker-compose overlays this, picking up live edits.
COPY . .

EXPOSE 8787

# --watch restarts the process on any file change under the working dir.
CMD ["bun", "--watch", "run", "src/index.ts"]
