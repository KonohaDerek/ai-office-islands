# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## AI Office prototype direction

- Use an island virtual office with distinct bot avatars.
- Keep public demo content generic and free of client, vendor, and outsourced-project names. The seeded demo uses the three departments 個人－投資、個人－影音部、個人－開發部 and seven sample groups.
- Keep bot and group navigation on the left; clicking either the map or sidebar opens a chat overlay; closing returns to the same office view.
- Keep external credentials in the local Vite integration middleware; persist them only as AES-256-GCM ciphertext in `~/Documents/Private/09_AI/ai-office-islands/settings.yaml` with the encryption key in macOS Keychain. Reuse this canonical settings file from isolated worktrees, while honoring an explicit `AI_OFFICE_SETTINGS_PATH` override. Never store credentials in browser storage or ship them in the client bundle.
- Use Hermes Agent's OpenAI-compatible API server and xAI Grok's OpenAI-compatible API for live chat. Hermes can import the current API Server profile's Agent and sessions, plus Bot Mode profile names from the local Hermes profiles directory; distinguish roster discovery from a live per-profile API connection. Start Bot Mode chat only after a user explicitly enables and tests that profile's dedicated `/p/<profile>/v1` route. General Hermes group/session chats must use the selected group session on the default profile, never a member's Bot Mode route. Grok API does not expose the Grok web custom-bot/group directory. Codex CLI conversation and identifiable subagent transcripts may be imported from local session files as read-only history; do not imply new messages can be sent back to Codex CLI.
- Bind the local development server to loopback when source integrations are enabled.
- Department zones are represented as selectable sub-islands within the active office; allow each department to choose a saved terrain preset, while each group remains a building and only a new office creates a separate office island. Keep department names on small planted wooden signs, edit sign position by dragging, and show names on hover or click.
- Let users double-click the office heading copy to edit its eyebrow, title, and description per office; the collapse control is icon-only. Remove ambiguous building-count badges when existing map labels already show the counts.
- Show the new-office onboarding hint only while the office has no bot and no group. Reflect the office's currently connected chat source in the hint; don't ask users to select a source again when one is already active. Use a `Manage sources` action in that state. Users can reopen Hermes roster/session management and Codex history import from source settings.
- Build department filters from the active office's imported groups, never from demo department labels. Keep a visible Hermes sync action in the sidebar beside the bot directory.

- Name the office entity `島嶼辦公室`; call its editable field `島嶼辦公室名稱`. Double-clicking either the sidebar office tile or top office switcher opens the same rename flow, and saving must update both labels together.
- Show active source state with color and text: green for connected, red for offline, amber for connecting, and a neutral/demo state when no external source is selected.
- Let users create reusable AI Office roles from a name, responsibility, and prompt; send that prompt through whichever Hermes, Grok, Claude, or Codex runtime is connected for the active office. Present OAuth login, API-key access, and local history import as distinct access methods where available; OAuth/API keys may enable live chat, while local history is read-only and never implies a live connection.
- The sidebar source action must follow the active office mode: Codex CLI import mode opens the Codex importer, Hermes-backed offices can sync Hermes, and other states open source management. Codex CLI is read-only history import, not a live chat connection; label it as a local archive rather than demo or live API.

- Keep characters on explicit, scene-specific walkable map paths. Animate slow directional steps along those paths and stop before group buildings or department signs; never use unconstrained wandering that can move an avatar over water or buildings.
- Prioritize useful in-island group collaboration before public Telegram/Discord webhooks. Manage group membership in the Members tab. Let users invite members into a conversation with @name or “everyone”; infer discussion versus task assignment from the message itself, with the coordinator as the default when no member is mentioned. Invited Agents respond in sequence and see earlier replies. Make per-Agent model calls and resulting usage clear, and never claim a text response executed external work unless that Agent has and used an authorized tool.
