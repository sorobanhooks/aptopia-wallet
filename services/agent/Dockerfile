# Agent backend (x402-paywall-server) — local dev image with hot reload.
#
# The source tree is bind-mounted at runtime (see docker-compose.yml), so this
# image only needs Node + installed deps. `npm run dev` (nodemon + ts-node)
# restarts the process on any file change.

FROM node:22-alpine

WORKDIR /app

# Install deps. The source is bind-mounted at runtime, but node_modules is
# baked in (and preserved by an anonymous volume) so the container has
# linux-native deps that the host bind mount cannot shadow.
#
# `npm install` (not `npm ci`) is used deliberately: the committed
# package-lock.json drifts from package.json (optional native deps such as
# @emnapi/* are absent from the lock), which makes `npm ci` fail. For this
# local dev image we tolerate the drift; regenerate the lockfile upstream if
# strict reproducibility is needed.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# Copy source for the initial image build. At runtime the bind mount from
# docker-compose overlays this, picking up live edits.
COPY . .

EXPOSE 3000

# nodemon + ts-node: restarts the process on any file change under the workdir.
CMD ["npm", "run", "dev"]
