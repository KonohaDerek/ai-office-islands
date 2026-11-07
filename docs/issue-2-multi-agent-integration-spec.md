# Issue #2: Multi-agent inbound integrations

## Problem and outcome

AI Office currently supports local, user-initiated conversations with connected providers. It does not provide a verified public Telegram or Discord entry point, durable task routing, or a secure path for a local Hermes service to receive cloud-originated work. Issue #2 asks for those capabilities and result delivery back to the source conversation.

## Priority decision: in-island collaboration first

The product owner asked to complete group-level collaboration before implementing external Telegram/Discord entry points. The first slice is inside AI Office: users add group members in the Members tab, then invite them from the conversation with @name or “everyone”; the message wording determines discussion versus task assignment, and invited agents answer sequentially with earlier replies in context. The existing single group coordinator remains the default when no one is mentioned, so ordinary messages do not trigger extra model calls. Each invited member makes one call through the active connected runtime. Local/public demo replies are labeled as simulations. A generated answer is a response, not proof that files or external services were changed; task execution requires a connected, authorized tool-capable runtime.

Public webhook and local bridge work remains a later slice of issue #2.

## Proposed external integration architecture

Use a separate Cloudflare Worker integration service so the existing static Sites Worker remains unchanged. Telegram and Discord requests are authenticated at the edge, normalized into tasks, deduplicated, and stored before acknowledgement. A Durable Object owns task state and rate limits. A local bridge makes an authenticated outbound long-poll connection, claims eligible work, dispatches through an explicitly selected configured provider, and submits progress/results. The edge service delivers completion to the originating Telegram chat or Discord interaction webhook.

The bridge must never expose localhost or accept unsolicited inbound network connections. Credentials stay in Cloudflare secret bindings or the local encrypted settings store; the browser never receives them. Task routing is explicit and capability checked. No automatic fallback to a different provider is allowed unless the user selected it.

## Requirements and acceptance scenarios

1. **Verified Telegram event:** accept a configured bot webhook only when Telegram's secret-token header is valid; reject malformed or unauthorized updates. Persist the task and event id before acknowledging it.
2. **Verified Discord interaction:** verify the Ed25519 signature and timestamp over the exact request body; reject invalid or stale requests. Acknowledge within the Discord deadline, then deliver task completion through the interaction response webhook.
3. **Deduplicated task:** repeated Telegram update IDs or Discord interaction IDs return the existing task and never dispatch twice.
4. **Explicit routing:** a task names an enabled agent and required capability. Reject unavailable agents or unsupported capabilities with a clear user-facing response; do not silently change model/provider.
5. **Outbound-only bridge:** bridge authenticates with a revocable per-installation secret, claims leased tasks, renews leases while working, and reports progress or a terminal result. Expired leases can be retried under a bounded policy without duplicate external replies.
6. **Provider boundary:** dispatch only to a provider explicitly connected in the local AI Office instance. Never imply that Grok custom bots or Dots can be directly invoked without an official supported interface.
7. **Rate limits and retention:** enforce per-source and per-installation limits; bound payload size and task lifetime; expire deduplication and task records according to a documented retention period.
8. **Failure visibility:** show offline bridge, expired lease, invalid credentials, unsupported capability, provider error, and delivery failure as distinct task states.
9. **Secret handling:** do not return secrets to clients or logs; redact credentials and signatures from error responses; support rotation and revocation.

## Constraints and compatibility

- Preserve `worker/index.js`, `.openai/hosting.json`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` unchanged for the existing Sites handoff.
- Add the integration service as a separate deployable unit; no production deployment is part of this change.
- Preserve existing local and demo conversation behavior. Demo mode must not claim that a real webhook or agent bridge is connected.
- Use current local encrypted settings for credentials consumed by the bridge. Public webhook secrets must be Cloudflare secret bindings and must not be copied into Vite/browser configuration.

## Dependencies, assumptions, and open decisions

- Assumption: Cloudflare Workers plus Durable Objects are the first hosting target because the repository already uses Cloudflare Pages/Workers for the public static demo. This remains an implementation proposal; no Cloudflare account, domain, or deployment is authorized by the issue.
- The owner must configure Telegram bot token and webhook secret, Discord application public key and bot/application credentials, Worker bindings, and the bridge installation secret before end-to-end acceptance can be demonstrated.
- Discord responses after the initial acknowledgement require an interaction webhook token with a bounded retention window; expired interaction tokens must result in a visible delivery failure.
- Need a product decision on the user-visible task selection syntax and authorization model (for example, per-chat allowlist and explicit agent command). The safe default is deny by default and administrator-managed chat allowlists.
- Need a retention choice before production use. Proposed default for this spec: task payloads and dedupe records expire after 7 days; secrets are never stored in task records.

## Task breakdown

Dependency order:

1. **Edge ingress and queue** — separate Worker, Durable Object schema, Telegram and Discord verification, dedupe, rate limits, task state, and unit tests. Ready after the routing syntax and authorization model are approved.
1. **In-island group collaboration** — manage membership in the Members tab; invite named participants from the conversation, infer task assignment from the message, keep task and reply states in the group conversation, and send one request through the active connected runtime per invited member. Implemented as the current first slice; live work remains dependent on the connected runtime's actual capabilities.
2. **Edge ingress and queue** — separate Worker, Durable Object schema, Telegram and Discord verification, dedupe, rate limits, task state, and unit checks. Ready after routing syntax and authorization are approved.
3. **Local outbound bridge** — registration/rotation, long polling, task leases, capability registry, local provider dispatch, and progress/result reporting. Depends on task 2 and the chosen task envelope.
4. **Result delivery and user controls** — Telegram/Discord replies, retry/expiry states, chat authorization settings, and visible source/task management. Depends on tasks 2 and 3.
5. **Operations and end-to-end acceptance** — deployment instructions, secret setup, abuse limits, retention, and live provider/webhook verification. Depends on 1–4 plus user-provided accounts and explicit deployment authorization.

The tasks share the task envelope and authorization model, so they should be implemented serially. No remote child issues or agent dispatch are created by this document.

## Verification plan

- Unit tests with signed and invalid Discord requests, valid and invalid Telegram tokens, repeated event IDs, oversized bodies, unauthorized chat IDs, task lease contention/expiry, rate limits, provider offline state, and reply expiry.
- Build the existing app and separately validate the integration Worker bundle without changing the Sites Worker entry point.
- End-to-end testing requires real Telegram/Discord test applications, a configured Cloudflare environment, and an explicitly enabled local bridge; none are configured or assumed here.

## Risks and rollback

- Public webhooks can be abused to spend provider quota or flood a bridge. Deny-by-default chat authorization, rate limits, body limits, leases, and revocation are required before exposure.
- Telegram and Discord protocol behavior or provider APIs may change; verification must use their current official specifications before implementation and again before deployment.
- Rollback is to disable webhook routes and revoke the bridge installation secret; existing task records may expire under the configured retention policy.
