# Server deployment

**English** · [简体中文](server-deployment.zh-CN.md)

The Mac app is the local-first desktop surface. A Mac without a public IP can
instead run the same Runtime and UI on a small Linux server. The server is an
orchestrator: use remote model providers. A 1 vCPU / 2 GB machine is intended
for the Main Agent, memory, scheduling, audit, and the WhatsApp bridge, not for
running a local language model.

## What is included

- `src/server-main.ts`: headless server entry with a stable bearer token.
- `Dockerfile`: Node 24 runtime image; no source build or local model.
- `compose.server.yml`: Clone AI plus Caddy, persistent data and workspace.
- `deploy/Caddyfile`: HTTPS, owner authentication, and a public WhatsApp webhook route.
- `deploy/server.env.example`: the server-only environment template.

The container listens on `4317` (UI/API) and `4318` (WhatsApp webhook). Neither
port is published directly. Caddy terminates TLS and is the only public entry.

## Prerequisites

- Linux server, 1 vCPU / 2 GB RAM minimum.
- 1-2 GB swap is recommended for the first image build on a 2 GB host.
- Docker Engine and Docker Compose v2.
- A domain whose A/AAAA record points at the server.
- Ports 80 and 443 open.
- Provider credentials for the remote model used by the Main Agent.

## Configure

1. Copy the server environment template:

```bash
cp deploy/server.env.example deploy/server.env
```

2. Generate the stable companion token:

```bash
openssl rand -hex 32
```

3. Generate a Caddy password hash for the owner login:

```bash
docker run --rm caddy:2.8 caddy hash-password --plaintext 'change-me'
```

4. Fill in `deploy/server.env`:

```dotenv
CLONE_AI_DOMAIN=agent.example.com
CLONE_AI_PUBLIC_URL=https://agent.example.com
CLONE_AI_COMPANION_TOKEN=<64 hex characters>
CLONE_AI_PROXY_SECRET=<another 64 hex characters>
CLONE_AI_BASIC_AUTH_USER=owner
CLONE_AI_BASIC_AUTH_HASH='<bcrypt hash>'
CLONE_AI_MAIN_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=<provider key>
```

Never commit `deploy/server.env`.

## Start

```bash
docker compose -f compose.server.yml up -d --build
docker compose -f compose.server.yml ps
docker compose -f compose.server.yml logs -f clone-ai
```

Open `https://agent.example.com`. Caddy asks for the username and password from
the environment file. The browser then receives the authenticated Clone AI UI.

The reverse proxy deliberately leaves `/webhook` public to Meta while the UI
and API remain behind owner authentication. That webhook has its own
HMAC-SHA256 signature check and phone-number allowlist.

## WhatsApp

Open **Connect phone** and provide the Cloud API values. On a server deployment
the wizard uses the fixed public origin:

```text
https://agent.example.com/webhook
```

Do not start a Cloudflare Tunnel in this mode, and do not expose `4317` or
`4318` in the host firewall. The server has no public IP requirement on the Mac
because the agent now runs on the Linux host.

## Data and updates

The Compose file uses named volumes `clone_data`, `clone_workspace`, and Caddy's
certificate/config volumes. Updating code does not remove them:

```bash
git pull
docker compose -f compose.server.yml up -d --build
```

Back up the data volume before upgrades:

```bash
docker run --rm -v clone-ai_clone_data:/data -v "$PWD":/backup \
  alpine tar czf /backup/clone-data.tar.gz -C /data .
```

## Limitations

- A 1 vCPU / 2 GB host must use remote providers; do not run a local LLM there.
- The headless image does not install Claude Code, Codex CLI, Pi, or other
  coding-agent CLIs. The Main Agent and remote model path work; black-box child
  workers need an appropriate provider installation or a future worker service.
- The server is single-owner. Do not share the Caddy login or companion token.
- The server still needs an HTTPS domain. The example leaves the domain unset
  on purpose; configure it before starting.
