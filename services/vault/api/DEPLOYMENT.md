# Baku API — VM Deployment Guide

This document describes how to deploy the Baku API (`palmyra/api`) on a Linux
VM behind nginx with TLS, managed by `systemd`.

The API is a Bun + Hono process. It is **stateless** apart from a 3-second
in-memory cache, holds **no secrets** (all signing happens client-side in the
wallet), and depends only on an outbound Soroban RPC endpoint.

---

## 1. Architecture at a glance

```
 wallet (Aptopia extension)
        │  HTTPS
        ▼
   ┌─────────┐      ┌──────────────┐      ┌──────────────────┐
   │  nginx  │ ───▶ │  Baku API    │ ───▶ │  Soroban RPC      │
   │  :443   │      │  bun :8787   │      │  (testnet/mainnet)│
   └─────────┘      └──────────────┘      └──────────────────┘
```

- **Single process**, restarted by `systemd` on crash.
- **No database**, no queue, no Redis.
- **No private keys** on the server. The API only builds and simulates
  transactions; clients sign and submit.

---

## 2. VM requirements

| Resource | Minimum                                     |
| -------- | ------------------------------------------- |
| OS       | Ubuntu 22.04 LTS or 24.04 LTS (Debian works)|
| vCPU     | 1                                           |
| RAM      | 1 GB                                        |
| Disk     | 10 GB                                       |
| Network  | Outbound HTTPS to Soroban RPC; inbound 22 (SSH), 80, 443 |
| DNS      | An A/AAAA record pointing to the VM (e.g. `api.example.com`) |

Software installed during setup: `curl`, `unzip`, `git`, `nginx`, `certbot`,
`ufw`, **Bun** (latest).

---

## 3. One-time VM bootstrap

SSH in as a sudo-capable user, then run:

```bash
# Packages
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl unzip git nginx ufw

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# Dedicated unprivileged service user
sudo useradd -m -s /bin/bash baku

# Install Bun as that user
sudo -iu baku bash -c 'curl -fsSL https://bun.sh/install | bash'
# Bun binary lands at /home/baku/.bun/bin/bun
```

---

## 4. Fetch the code

As the `baku` user:

```bash
sudo -iu baku
git clone <your-repo-url> palmyra
cd palmyra/api
~/.bun/bin/bun install --production
```

For a private repo, use a deploy key or `gh auth login` before cloning.

---

## 5. Environment configuration

Create `/home/baku/palmyra/api/.env`:

```bash
# Port the Bun server listens on (loopback only; nginx fronts it)
PORT=8787

# Network selection: testnet | mainnet
NETWORK=testnet

# Soroban RPC endpoint.
#   testnet default: https://soroban-testnet.stellar.org
#   mainnet:         use your provider's mainnet RPC URL
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Optional: explicit network passphrase. Defaults to Networks.TESTNET.
# Set this for mainnet:
#   NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
# NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Funded G-address used only as a simulate-only "source" for read calls.
# Does NOT sign. Any funded account works.
ADMIN_ADDR=GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV
```

Lock it down:

```bash
chmod 600 /home/baku/palmyra/api/.env
```

### Environment variables reference

| Variable             | Required | Default                                 | Notes                                                       |
| -------------------- | -------- | --------------------------------------- | ----------------------------------------------------------- |
| `PORT`               | no       | `8787`                                  | Bind port                                                   |
| `NETWORK`            | no       | `testnet`                               | Used by route handlers to select address book                |
| `SOROBAN_RPC_URL`    | no       | `https://soroban-testnet.stellar.org`   | Override per environment                                    |
| `NETWORK_PASSPHRASE` | no       | `Networks.TESTNET` from `stellar-sdk`   | Required override for mainnet                               |
| `ADMIN_ADDR`         | no       | hardcoded testnet funded account        | Must be funded on the target network                        |

---

## 6. systemd unit

Create `/etc/systemd/system/baku-api.service` as root:

```ini
[Unit]
Description=Baku API (Bun + Hono)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=baku
Group=baku
WorkingDirectory=/home/baku/palmyra/api
EnvironmentFile=/home/baku/palmyra/api/.env
ExecStart=/home/baku/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/baku/palmyra/api

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now baku-api
sudo systemctl status baku-api
```

Smoke test from the VM itself:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"t":"..."}
```

Logs:

```bash
journalctl -u baku-api -f
```

---

## 7. nginx reverse proxy

Create `/etc/nginx/sites-available/baku-api`:

```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/baku-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 8. TLS with Let's Encrypt

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

`certbot` rewrites the nginx config to listen on 443 and installs a renewal
timer. Verify:

```bash
sudo systemctl list-timers | grep certbot
```

---

## 9. End-to-end verification

From any machine:

```bash
curl https://api.example.com/health
curl https://api.example.com/addresses
curl https://api.example.com/vault/xlm/state
```

Expected:

- `/health` → `{"ok": true, ...}`
- `/addresses` → JSON map of deployed contract addresses for the configured
  network.
- `/vault/xlm/state` → vault state (total assets, price per share, APY, active
  strategy address).

Then point the Aptopia wallet extension's API base URL at
`https://api.example.com` and exercise a deposit end-to-end.

---

## 10. CORS

`hono/cors` is not currently enabled in `src/index.ts`. If you serve a browser
client from a different origin and see blocked requests:

**Option A — at the app layer** (preferred). Add to `src/index.ts`:

```ts
import { cors } from "hono/cors";
app.use("*", cors({ origin: ["chrome-extension://<id>", "https://app.example.com"] }));
```

**Option B — at nginx**:

```nginx
add_header Access-Control-Allow-Origin  "https://app.example.com" always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS"      always;
add_header Access-Control-Allow-Headers "Content-Type"            always;
if ($request_method = OPTIONS) { return 204; }
```

---

## 11. Updating the deployment

```bash
sudo -iu baku
cd ~/palmyra && git pull
cd api && ~/.bun/bin/bun install --production
exit
sudo systemctl restart baku-api
journalctl -u baku-api -n 50 --no-pager
```

Rollback is `git checkout <prev-sha> && bun install --production && systemctl
restart baku-api`.

---

## 12. Operational notes

- **Scaling:** the process is CPU-light and stateless. Run multiple replicas
  behind nginx `upstream` if you need horizontal scale; each replica keeps its
  own 3 s cache, which is fine.
- **Rate limiting:** none built in. The upstream Soroban RPC enforces its own
  limits. If you need protection, add nginx `limit_req` or put Cloudflare in
  front.
- **Monitoring:** `journalctl -u baku-api` for logs. For metrics, scrape
  `/health` from your uptime check. There are no Prometheus endpoints yet.
- **Mainnet checklist:**
  1. `NETWORK=mainnet`
  2. `SOROBAN_RPC_URL=<mainnet RPC>`
  3. `NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`
  4. `ADMIN_ADDR=<a funded mainnet G-address>`
  5. Confirm `api/src/addresses.ts` carries the mainnet contract addresses.

---

## 13. Alternatives

### Docker

Minimal `Dockerfile` (not yet in repo):

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
```

Run:

```bash
docker build -t baku-api ./api
docker run -d --name baku-api --restart=always \
  --env-file ./api/.env -p 127.0.0.1:8787:8787 baku-api
```

Front with the same nginx config from §7.

### Managed platforms

Bun is supported out of the box by Fly.io, Railway, and Render. Each replaces
sections 3, 6, 7, 8 with a platform-managed equivalent; the `.env` contents
from §5 remain the same.
