# Local Agent Status Visibility (Issue #12 foundation)

## Goal

Show which connected AI roles are working, idle, waiting for input, complete, in error, or unavailable directly on the island map. Include Herdr Core (`hc`) as a local source that observes the status programs report in its terminals. The user should be able to spot who is not doing work without opening each chat, and explicitly send one message at a time to a listed local Herdr Core agent that is idle or working.

## Workflow route and evidence

- Project release source: official GitHub Releases API for `KonohaDerek/ai-office-islands`, checked 2026-11-15; it returned an empty release list (no published stable release found).
- Release-based route: Codex plans, Claude implements. The user authorized implementation of this scope.
- Jev was not invoked; `TYPESAFE_API_KEY` was absent, so `jev_fallback=active_agent_host_default`.
- Plan base: `1a41cea946a574fe1ee081ff61ff1f7bbdbf281c` (`origin/main` at planning time).

## Approved scope for this phase

- Local, same-machine integrations only. No Telegram, phone replies, host pairing, remote adapter, external Worker, or production deployment in this phase.
- Status is source-backed semantic activity, not inferred from character animation or recent chat timestamps.
- Persist only safe source identity and presentation data under existing project settings rules; never read or display pane output to derive status.
- A source roster or imported history is not evidence of a live connection or current activity.

## Herdr Core contract

This feature uses **Herdr Core** (`hc`, installed `hc 0.1.20`), not the Herdr TUI (`herdr 0.9.5`). They are separate products. The Herdr TUI socket API (`~/.config/herdr/herdr.sock`, protocol 22, `session.snapshot`/`agent.list`/pane events) is not used anywhere in this feature.

- Contract sources: the installed `hc schema` (OpenRPC 1.3.2, `herdr-core` 0.1.20, protocol generation 1) and the official herdr-core v0.1.20 docs `schema/README.md` (connection modes, events, status) and `docs/security.md` (state and endpoints).
- Transport: JSON-RPC 2.0, one message per line (plain mode), over Core's local Unix socket. Framed mode and attach streams are not used.
- Endpoint resolution, in order: `HC_SOCKET`; the top-level `socket` setting in `$XDG_CONFIG_HOME/herdr-core/config.toml` (default `~/.config/herdr-core/config.toml`); `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`; `/run/user/<uid>/herdr-core/<session>.sock` when that runtime directory exists; otherwise the session state directory `$XDG_STATE_HOME/herdr-core/<session>/<session>.sock` (default `~/.local/state/herdr-core/default/default.sock`). `<session>` is `HC_SESSION` or `default`. On this Mac the fallback resolves to the state-directory socket; no credential or permission change is needed.
- Methods the product may send, each refused before it reaches the socket unless it is allowlisted for that connection and has the expected parameter shape:
  - Status stream connection: only `hello` (generation 1) and `events.subscribe`.
  - Explicit message connection (one per user Send, closed afterwards): only `hello`, `terminal.get {terminal}` for a currently listed repo-filtered address, and `terminal.send {terminal, text, if}` with `if` equal to `idle` or `working`. `force`, `wait`, `caller`, and `timeout` are never sent, and a `terminal.send` with any other key is refused locally.
  - Never sent: `terminal.list`, `terminal.read`, `terminal.attach`, `terminal.keys`, `terminal.interrupt`, `terminal.kill`, `terminal.run`, `terminal.put`, `machine.exec`, shell, `file.*`, `doc.get`, or `doc.set`. No subprocess is started.
- Repo label filter: the default source always subscribes with Core's supported `labels` filter `{"repo": "ai-office-islands"}`, so Core only sends terminals carrying `repo=ai-office-islands`. A source cannot be constructed without a non-empty label filter, and this app never subscribes to unfiltered terminals. Records that still arrive without a matching label (snapshot, `missed`, `created`, `restarted`, or `labels` with `record`) are dropped at ingress, and a `labels` event that stops matching removes the terminal. Label the terminals to observe, e.g. `hc label <t> repo=ai-office-islands` or `hc run --label repo=ai-office-islands …`.
- Safe-field projection at ingress: every Core record is reduced, before it is stored, to `address`, live/finished `state`, the reported `status.state` (one of the five supported words, otherwise marked unrecognized), `status.progress` only when defined (0–100), `status.app` only when it is an allowlisted generic agent kind (Claude Code, Codex, Hermes, Gemini CLI, Aider, OpenCode, Goose, Amp), and the `reported` boolean. Terminal name, title, argv, cwd, foreground, labels, screen, status message/title, and other 7501 records are never retained in memory, cached, or returned over HTTP. Map and sidebar names come only from the generic agent kind, or the neutral `Herdr Agent`; project or task names are never shown.
- Sync: after `hello`, `events.subscribe` returns `{seq, terminals}` as the initial filtered snapshot; the connection then carries `event`, `heartbeat` (every 15 s), and `missed` notifications. Apply events per Core's table (`created`, `restarted`, `removed`, `finished`, `lost`, `status`, `labels`). Ignore events whose `seq` is not above the current one. Because `seq` is core-wide, a filtered stream normally skips numbers and heartbeats may carry a higher `seq`; that only advances the local `seq`. Real loss is reported by Core as `missed`, which replaces the snapshot. No message for 45 s, a socket close, or an error marks the source offline and reconnects with backoff, taking a fresh filtered snapshot (Core's `seq` restarts per core process).
- Status: only what a program reports through OSC 7501 (the `status.state` root record). Core never infers status, and neither does AI Office: screens, output, titles, `argv`, `cwd`, `foreground`, status messages, and process activity are never read for status or displayed. A terminal whose program never reported, cleared its status, or was lost has no status and shows 狀態未知. Progress is shown only when the program itself reported it (Core's `status.progress`, 0–100, working/blocked only).
- Explicit message (see below) is the only write. The status stream itself stays read-only.
- Scope: live terminals on the local core only. Terminals of machines added to Core (`machine/t7`) and finished terminals are not shown. Each source is keyed by a hash of its endpoint, so identical terminal addresses on different cores stay distinct.

## Explicit user-to-agent message

The Herdr Core terminal dialog has a composer. Nothing is sent when the dialog opens. A message is submitted only when the user presses the Send button or Enter (Shift+Enter inserts a newline), one message per press. The composer states that the message goes to the selected local Herdr Core agent and may trigger actions according to that agent's own permission settings.

- Route: `POST /api/agent-status/message`, same loopback-only dev middleware as the status route. It applies the same loopback peer, `Host`, `Origin`, and `Sec-Fetch-Site` rules, and also requires `POST`, a present same-origin `Origin`, `Content-Type: application/json`, and a body of at most 16 KiB. It is disabled (404) when `VITE_PUBLIC_DEMO=true` or `AI_OFFICE_HERDR_CORE_STATUS=off`. Responses are `no-store` JSON.
- Body: exactly `{sourceKey, address, text}`. `sourceKey` is the opaque `c` + 10 hex key from the status route, and `address` must match `t[0-9A-Za-z]{1,32}`. The client never supplies a method, flag, terminal name, or machine-qualified address. `text` is 1–4000 characters with no control characters other than newline and tab (no ESC, CR, C1, or line/paragraph separators), so it cannot carry terminal escape sequences.
- Target binding: the address must be in the selected source's current repo-filtered list, the source must be connected and not stale, and the listed status must be `idle` or `working` with a recognized agent kind. Otherwise Core is not contacted.
- Fresh re-check: on a new connection, `hello`, then `terminal.get` for that address. The record is projected at once to derived values only (address, label match, live, reported, status word, generic app kind, dialog flag, and a generic runtime kind from the foreground program's name and `argv[0]` basename), and the raw record is dropped. Sending is refused if the labels no longer match, the terminal is not live, the status is absent, `blocked`, `done`, `error`, or unrecognized, a permission/question/auth dialog `kind` is present, the app kind is not allowlisted, the foreground identity is unknown or ambiguous (its name and `argv[0]` disagree), the identity differs from the reported app kind, or the kind differs from what the user selected.
- Send: `terminal.send` with no `force` and `if` set to the fresh status word. Core therefore refuses a blocked program and refuses if the status changed between the check and the send. The tool never answers permission, auth, or question dialogs.
- Outcome shown under each local message: `已提交給 Herdr Core` (Core accepted the text, with Core's `started` evidence: became working, did not become working, or not reported); `未傳送` (a guard refused, nothing sent); `Herdr Core 拒絕輸入` (Core error kinds that mean nothing was typed, such as `blocked`, `status_mismatch`, `finished`, or `unavailable`); `結果不明` (timeout, lost connection, `cancelled`, or an unexpected error after the send was issued). Nothing is retried automatically, and every non-submitted outcome tells the user to check the target in Herdr Core before resending. Only one message per agent may be in flight. AI Office never reads terminal output, so it never shows or implies an agent reply.
- Composer availability: disabled with an explanation for `blocked` (handle the dialog in the terminal itself), `done`, `error`, `狀態未知`, `來源離線`, a terminal no longer listed, or a missing agent kind. Submitted messages are kept only in page memory for the session, not in browser storage or settings.
- Fail-closed runtimes: a runtime whose foreground process is a generic interpreter (`node`, `python`), a wrapper, or a process titled with a version string instead of its program name has no verifiable identity, so its composer passes the client check but every send is refused with `unknown_identity` or `ambiguous_identity`. Accepted foreground names: `claude`, `codex`, `hermes`, `gemini`, `aider`, `opencode`, `goose`, `amp`. These names have not been verified against a live Core in this phase.

## Normalized status and map display

| Core `status.state` | Display label | Light |
| --- | --- | --- |
| `working` | 工作中 | Green |
| `idle` | 閒置 | Neutral blue/gray |
| `blocked` | 等待協助 | Amber |
| `done` | 已完成 | Teal |
| `error` | 錯誤 | Plum (distinct from offline red) |
| absent, unrecognized, or never reported | 狀態未知 | Gray |
| source disconnected | 來源離線 | Red |

Every avatar on the map keeps a visible light. The map also has a concise legend. Accessible text and the status label must communicate state without relying on color alone. The same state appears in the agent details/sidebar. A system may report its own numeric progress only if its supported API defines that value; otherwise show semantic state and last update time.

For runtimes without a supported live activity API, show live request activity initiated by AI Office only while that request is active. Treat imported local history as read-only and show its activity as unknown/archived, never as currently working or idle.

## Acceptance checks

1. On the map, every connected role has a visible state light and readable state; an idle role is explicitly labeled 閒置.
2. A source state transition updates the map and agent details without a page reload; stale or disconnected source state becomes 來源離線/狀態未知 rather than remaining 工作中.
3. Herdr Core status transitions map exactly from the reported `idle`, `working`, `blocked`, `done`, and `error` words; anything else or no report is 狀態未知. Same terminal addresses on distinct cores remain distinct.
4. Source roster discovery, imported history, and real-time status are clearly distinguished; unsupported sources do not receive fabricated activity.
5. Tests use a fake Herdr Core socket speaking JSON-RPC 2.0 and cover the initial event snapshot, status transitions, missed/seq-gap/heartbeat resync, reconnect after disconnect, stale streams, malformed or unknown messages, title/foreground events not changing status, offline display, and refusal of unsafe methods. No live agent is started and no terminal screen or output is read.
6. No remote Worker, Telegram notification, phone reply, public endpoint, or deployment is added.
7. The Herdr Core dialog never sends on open. Send submits exactly one `terminal.send` for the selected listed repo agent after a fresh guarded `terminal.get`, without `force` and with an `if` precondition of `idle`/`working`. Blocked, stale, offline, done, error, unknown, unidentified, or ambiguous targets are refused with an explanation. Failed or uncertain sends are not retried, and the UI asks the user to check the target first.

## Risks and limitations

- Core status is only as good as each program's OSC 7501 reports. Programs that do not report stay 狀態未知; screen text is never scanned to guess.
- Herdr Core's API is a preview (protocol generation 1, version 0.x). A different generation is refused and the source shows 來源離線.
- Only terminals labelled `repo=ai-office-islands` appear; unlabelled terminals stay invisible until someone labels them. Labelled plain shells show 狀態未知.
- Messages are typed into a real agent program running with the user's account. What that agent then does depends only on its own permission settings; Herdr Core is not a sandbox and `blocked` is not an access boundary. The UI says so beside the composer.
- A program that shows a dialog without reporting `blocked` cannot be detected without reading the screen, which this feature never does. `if` and the absence of `force` only protect against reported states.
- Core may delay typing while a person is drafting in that terminal (up to 60 s). AI Office waits up to 75 s and then reports 結果不明, because the text may still be typed later.
- Foreground identity uses only process names, which a local process can choose. Same-account local processes are already inside Core's trust boundary.
- There is no automatic group fan-out, dispatch, or scheduled sending; group chats cannot include Herdr Core agents.
- The original Issue #12 includes remote pairing and Telegram replies. This local foundation does not close #12; later work needs a separately reviewed phase for those acceptance items.

## Validation

- Unit tests for status normalization and color/label mapping.
- Integration tests against a fake Herdr Core socket (JSON-RPC 2.0, generation 1) that implements `hello`, `terminal.list`, `events.subscribe`, `terminal.get`, and `terminal.send` (with Core's `force` and `if` rules and injectable refusals, hangs, and drops), never types into a real program, honors the `labels` filter for the snapshot and `event`/`missed` notifications, and includes a synthetic company-like terminal with a non-matching label. Tests prove that record never enters source state or HTTP output, that every subscribe carries the repo filter, and that cached records hold only the allowlisted projected fields after the snapshot, `created`, and `status` events.
- Message tests (`tests/agent-message.test.mjs`) cover the exact request sequence and parameters on the happy path, repo/address/source binding, listed-state guards, every fresh re-check refusal, offline and stale sources, Core refusals without retry, uncertain timeouts/drops/cancellation, one in-flight send per agent, local method and parameter refusal (including `force` and a missing or blocked `if`), text validation, HTTP origin/JSON/size/shape/disabled rules, composer availability, and delivery wording that never implies a reply. No real agent is messaged and no live Core is contacted.
- Existing project overview, integration, build, and Sites checks as applicable to the final diff.
