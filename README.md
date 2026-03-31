Node.js crawler backend for the Cloudflare Worker control layer.

## What It Does

- Exposes a protected HTTP API for the Cloudflare Worker.
- Checks page targets and RSS feeds without Python.
- Stores mutable config in YAML and runtime state in JSON.
- Supports auto-check and auto-push as separate per-source switches.
- Pushes notifications through the Cloudflare Worker relay endpoint.

## Expected Cloudflare Worker Contract

This service matches the Worker routes already in use:

- `GET /health`
- `GET /targets`
- `GET /feeds`
- `POST /check/all`
- `POST /check/target`
- `POST /check/feed`
- `POST /sources/control`
- `POST /targets/add`
- `POST /targets/remove`
- `POST /feeds/add`
- `POST /feeds/remove`

## Files

- `config.example.yaml`: token-free config example
- `data/config.yaml`: runtime config copied from the example
- `data/state.json`: runtime state file
- `.env.example`: environment variables

## Local Run

1. Copy `config.example.yaml` to `data/config.yaml`
2. Copy `.env.example` to `.env`
3. Set `VPS_SHARED_TOKEN` to the same value used in Cloudflare
4. Set `RELAY_URL` to `https://bot.your-domain/relay/send`
5. Run `npm install`
6. Run `npm start`

## Docker Run

1. Copy `config.example.yaml` to `data/config.yaml`
2. Copy `.env.example` to `.env`
3. Fill in `.env`
4. Run `docker compose up -d --build`

## Notes

- `VPS_SHARED_TOKEN` is required for both:
  - Worker -> VPS API authentication
  - VPS -> Worker relay authentication
- Telegram token does not live in this service.
- Manual checks do not emit auto-push notifications.
