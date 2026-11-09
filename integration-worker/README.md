# External chat ingress (phase 1)

This Worker is separate from the static Sites Worker in `../worker/index.js`.
It accepts Telegram bot webhooks and Discord HTTP interactions, stores bounded
tasks in a per-installation SQLite Durable Object, and exposes an authenticated
outbound bridge API. The local bridge polls the Worker and calls only the
loopback AI Office integration API.

## Local Worker

Run `npm run worker:dev`. Local-only fake webhooks can be sent to
`http://127.0.0.1:8787/webhooks/telegram` and `/webhooks/discord` after setting
the corresponding Wrangler dev secrets and allowlists. Do not point real
Telegram or Discord webhooks at a local development Worker.

Set secrets with Wrangler for a real test environment (never commit them), for
example `npx wrangler secret put BRIDGE_TOKEN --config integration-worker/wrangler.toml`.
Repeat for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY`,
and `DELIVERY_TOKEN_KEY`. Use the same randomly generated `BRIDGE_TOKEN` in the
local encrypted bridge setup. `DELIVERY_TOKEN_KEY` must be 32-byte hex or
base64. Configure `ENABLED_AGENT_IDS`, `ALLOWED_TELEGRAM_CHAT_IDS`,
`ALLOWED_DISCORD_GUILD_IDS`, and `ALLOWED_DISCORD_USER_IDS` explicitly; blank
allowlists deny all requests. Telegram's bot token is only used to send replies.

## Local bridge

First start the AI Office local server with `npm run dev:local`, connect the
provider(s) in the app, then run `npm run bridge:configure`. It encrypts the
Worker URL, bridge bearer token, and explicit Agent-to-provider routes into
`~/Documents/Private/09_AI/ai-office-islands/settings.yaml` using the existing
AES-256-GCM/Keychain key. This same file is reused when running from a worktree.
Routes can
select `Hermes`, `Grok`, `Claude`, `OpenAI`, `ClaudeOAuth`, or `CodexOAuth` and
may set a model, system prompt, and (for Hermes) an already-enabled Bot Mode
profile. The selected source must be connected; there is no fallback.

Run `npm run bridge` in a second terminal. It polls every two seconds, leases a
single task at a time, renews its lease while waiting for the provider, then
submits a result or a visible failure. The bridge makes outbound requests only;
it does not listen on a network port. Set `AI_OFFICE_LOCAL_API` only if the
loopback Vite port differs from 4173.

## Operational limits

- Commands are `/ask <agent-id> <prompt>` and `/task <agent-id> <prompt>` in
  Telegram, and `/ai-office ask|task agent:<id> prompt:<text>` in Discord.
- Discord's application command must be registered separately with the same
  option names. Configure its interactions endpoint to `/webhooks/discord`.
- Telegram webhook setup must include the configured `secret_token` and point
  to `/webhooks/telegram`.
- Request bodies are limited to 16 KiB, prompts to 12,000 characters, results
  to 8,000 characters. Limits are 30 tasks per source per hour and 100 per
  installation per hour; payload and deduplication rows expire after 7 days.
- Discord interaction delivery tokens are encrypted separately from tasks and
  expire after 14 minutes. They are deleted after a delivery attempt.
- There is no self-service enrollment route, fan-out, tool permission grant,
  webhook registration, secret provisioning, or production deployment here.

Run `npm run test:integrations` for protocol tests. Deployment requires separate
operator configuration, live account tests, and explicit approval.
