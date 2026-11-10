# Issue #8 — mobile project overview

## Authorization and routing
User requested on 2026-11-10: mac mini 上開始處理個專案issue.
Issue #8 is selected for a bounded read-only local overview implementation.
GitHub releases queried successfully 2026-11-10: empty list; route locked to Codex plan / Claude implementation. Base main 1e21273a04ee094602b23f81c437211ee8e4c3eb. Worktree isolated at ai-office-islands-issue-8; branch codex/issue-8-mobile-status. Existing dirty canonical checkout and issue-2 worktrees must remain untouched.

## Requirements
Provide one mobile-first project overview with all registered Herdr projects, work status, task summary, source and observation timestamp. Prioritize blocked/waiting items; drill into one project, retain island view. Agent turn completion must not become product completion. Unknown, disconnected and stale data must be explicit. Desktop and mobile read the same server snapshot, not independent browser project registries.

## Implementation boundary
Build a small server-side GET-only local adapter using fixed allowlisted commands (`herdr-app ls`, `hc ls --all`) with execFile (no shell interpolation). Use explicit timeouts/output limits and sanitize responses. Read only terminal metadata and registered project name/ID; never terminal text, prompts, paths, credentials, history, session tokens or arbitrary commands. Do not hardcode personal project names into public demo. No writes/control or actions in the endpoint. Failure is unknown, not idle or done. When source timestamps are absent use observedAt and explain it is observation time, not work-update time. Unknown per-task evidence remains unknown; no PR/build/deployment/acceptance claims.

Prefer a separate Vite plugin/module and React component to minimize App integration diff. Endpoint must reject non-GET, foreign Origin/Host and non-loopback connections; do not expand existing listener/network/credential settings. Public demo disables the local adapter and shows a clearly labelled unavailable/demo state. Local loopback-only availability is NOT phone remote access; record phone-over-network as unverified/deferred pending an authorized secure access route. Do not publish, deploy, bind 0.0.0.0, install relays, or change firewall/Tailscale.

## Tests and acceptance
Unit tests for normalization, blocked-first sorting, unknown/missing state, stale thresholds, source errors, malicious strings, secret/path exclusion, invalid Origin/Host/method and public-demo disabling. UI handles loading, retry, offline and refresh race/cancellation; no duplicate launches. Mobile 390x844 and desktop screenshots/checks with isolated demo browser storage where possible. Run existing tests, build, test:sites plus new tests. Report exact commands and outcomes. Preserve .openai/hosting.json, worker/index.js, scripts/prepare-sites-build.mjs and tests/sites-worker.test.mjs.

## Review and delivery
No push/PR/merge/release/deploy in this task phase. Finish implementation with test evidence; independent actual Codex and actual Claude reviewers must review the same final candidate SHA. Implementation session cannot self-approve. Track each round (max five) and findings without fabrication. Remaining real-device and private access acceptance must stay incomplete. Rollback is to not merge this isolated branch; no deletion/cleanup authorized.
