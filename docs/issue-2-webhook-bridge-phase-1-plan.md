# Issue #2: webhook and local bridge phase 1

## Status

Approved for local implementation with the defaults below. No provider accounts, Cloudflare resources, webhooks, or deployments have been configured.

## Goal

Let an allowlisted Telegram chat or Discord server submit an explicit request to an enabled AI Office Agent, then receive its result in the originating conversation. Keep local Hermes and other private services behind an outbound-only bridge. The existing static Sites Worker stays unchanged.

## Proposed defaults for approval

1. **Hosting:** a separate Cloudflare Worker with SQLite-backed Durable Objects for task state, deduplication, rate limiting, and leases. This is an implementation choice, not deployment authorization.
2. **Commands:** Telegram `/ask <agent-id> <prompt>` and `/task <agent-id> <prompt>`; Discord `/ai-office ask agent:<agent-id> prompt:<text>` and `/ai-office task agent:<agent-id> prompt:<text>`. Both commands name exactly one Agent. Multi-Agent fan-out is not part of this remote command protocol's first version.
3. **Authorization:** deny by default. A Telegram chat ID must be on the configured allowlist. A Discord guild ID and invoking user ID must both be allowed. Source allowlists are operator-managed Worker configuration; there is no public self-service enrollment endpoint.
4. **Retention:** delete task payloads and event-deduplication records after 7 days. Never persist webhook secrets, bot tokens, bridge tokens, or Discord interaction tokens in task records or logs.
5. **Task semantics:** `/ask` and `/task` both produce an AI response; the second labels intent for the Agent. Neither claims that files or external services changed unless an explicitly authorized tool-capable connector actually performed that action.
6. **Limits:** reject bodies above 16 KiB, cap each source at 30 accepted tasks/hour and each installation at 100/hour, and permit at most one active bridge lease per task. These are conservative initial defaults to tune before a public launch.

## Architecture

```text
Telegram webhook ─┐
                  ├─► Integration Worker ─► per-installation Durable Object/SQLite
Discord endpoint ─┘                                 ▲
                                                    │ outbound poll + lease/result
Local bridge ──────────────────────────────────────┘
     │
     └─► loopback-only AI Office integration API ─► explicitly selected provider/Agent
```

The Worker verifies the incoming source, validates the command and allowlist, deduplicates the platform event ID, and persists a bounded task before acknowledging it. A Discord interaction receives the required prompt acknowledgement immediately after persistence; the bridge completes the task and the Worker sends a follow-up while the interaction token is valid. Telegram completion is sent to the original chat. A revoked or expired delivery credential becomes a visible terminal delivery-failure state. Because Discord follow-ups require the interaction token, the Worker stores it only as authenticated ciphertext in a separate, short-lived delivery-metadata table keyed by task ID; it is never copied into a task payload or log and is deleted on delivery or expiry.

The bridge initiates all network connections. It authenticates with a revocable per-installation bearer secret, leases only tasks routed to an enabled Agent, renews a lease while processing, and submits progress plus one terminal result. A provider must be explicitly configured and online; there is no provider fallback. The bridge calls only the existing loopback-bound integration API and never opens an inbound port.

## Acceptance checks

- Valid Telegram webhook secret and Discord Ed25519 signature are required; invalid or stale Discord requests are rejected. Discord signature verification uses the timestamp concatenated with the exact raw request body.
- Discord PING receives PONG. Valid but unauthorized events are rejected without creating tasks.
- Repeated Telegram update IDs and Discord interaction IDs create at most one task and never dispatch twice.
- Queue persistence happens before source acknowledgement; malformed, oversized, unauthorized, duplicate, and accepted requests have distinct outcomes.
- Task routing is explicit; unknown, disabled, offline, or capability-incompatible Agents fail visibly without silently selecting another runtime.
- The bridge can claim, renew, complete, and fail a lease. A competing bridge cannot hold the same live lease; expired leases follow a bounded retry policy.
- Source delivery and delivery failure are reflected in the task status. No background or server-less response is marked complete merely because it was accepted into the queue.
- Automated protocol tests use generated test keys and fake provider/delivery endpoints; no real credentials or deployment are needed.
- Existing `worker/index.js`, `.openai/hosting.json`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` remain unchanged.

## Ordered work

1. **Edge ingress + queue** — separate Worker routes, signature/secret checks, command parsing, allowlists, Durable Object schema, dedupe, rate limits, status lifecycle, and deterministic tests.
2. **Local bridge** — outbound polling, installation token rotation/revocation, lease renewals, capability registry, loopback provider dispatch, progress/result submission. Depends on task 1's envelope.
3. **Source delivery + controls** — Telegram/Discord responses, authorization/Agent routing configuration, visible task failure states, and local source controls. Depends on tasks 1 and 2.
4. **Operations acceptance** — secret setup, retention cleanup, abuse limits, runbook, and live account tests. Requires separately supplied test applications and explicit deployment approval.

Run tasks serially: the task envelope, authorization, and Worker routes are shared contracts. No remote tickets, agent dispatch, live webhook registration, paid plan changes, or production deployment are included.

## Risks and rollback

- Public webhook traffic can consume Worker and provider quota. Deny-by-default source allowlists, strict payload limits, duplicate suppression, rate limits, bounded leases, and kill switches are required before live use.
- Durable Object billing can exceed free allowances; the current Workers Paid plan has a $5/month minimum. Confirm current usage and account plan before deployment.
- Discord interaction delivery tokens are time-limited; late results must become visible failures rather than disappearing.
- Rollback disables the Worker routes and revokes the bridge installation token. Existing task and dedupe records expire under the 7-day retention policy.

## Source references

- [Telegram Bot API: setWebhook and secret_token](https://core.telegram.org/bots/api#setwebhook)
- [Discord Interactions: HTTP endpoint and signature verification](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/overview.mdx)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
