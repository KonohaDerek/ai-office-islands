# Issue #8 — implementation record

Implementer: Claude (Claude Code, model `claude-opus-5-5`). Planner: Codex (`docs/issue-8/plan.md`).
Date: 2026-11-10. Branch `codex/issue-8-mobile-status`, base `1e21273`. Isolated worktree only; no push, PR, merge, release or deploy.
This session cannot approve its own work. The independent Codex and Claude reviews required by the plan have **not** been run yet.

## What changed

| File | Change |
| --- | --- |
| `server/project-overview.mjs` (new) | Read-only adapter and Vite plugin serving `GET /api/project-overview`. |
| `src/ProjectOverview.jsx` (new) | Overview panel: full screen on mobile (≤640px), right-hand drawer on desktop. The island view stays underneath. |
| `src/project-overview-utils.mjs` (new) | Pure display helpers: status labels, freshness, error mapping, summary. |
| `tests/project-overview.test.mjs` (new) | 23 unit tests (after round 1). |
| `src/App.jsx` | +1 import, one `overviewOpen` state with a stable close callback, a top-bar trigger button and one `<ProjectOverview>` render. |
| `src/styles.css` | Overview styles, plus a ≤480px top-bar fix so `連接來源` does not wrap after the new button was added. |
| `vite.config.mjs` | Registers `projectOverviewPlugin()`. Host, port and `allowedHosts` are unchanged. |
| `package.json` | Adds the `test:overview` script. |

Unchanged: `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, `tests/sites-worker.test.mjs` (`git diff --quiet` confirmed), `server/integrations.mjs`, and all Telegram/Discord code.

## Safety boundary as implemented

- **Fixed commands.** The adapter can run only two frozen argv lists: `herdr-app ls` and `hc ls --all --json`.
  - `--json` is the machine-readable form of the planned `hc ls --all`.
  - Commands run through `execFile` with `shell:false`, a 4s timeout, `SIGKILL`, a 1 MiB `maxBuffer`, and an env limited to `PATH`/`HOME`/`LANG`.
  - No request data ever reaches argv.
- **Fields kept.** The output contains only:
  - project ID (Herdr space ID if `[A-Za-z0-9_-]{1,64}`, otherwise an opaque `p_<sha256 prefix>`)
  - sanitized project name
  - per-status agent counts and agent-kind counts (Claude Code, Codex, Hermes)
  - Terminal identity (round 1): if Herdr gives no `app` and hc cannot vouch for the terminal (hc failed, hc output invalid, or the address is missing from hc), the terminal is counted as `unidentified` and as `counts.unknown`. It is not counted as a shell or as "no agents". A project whose only terminals are unidentified rolls up to `unknown`, not `none`.
  - Ended counts (round 1): `ended` per project and `unattributedEnded` are `null` (unknown) when hc is not `ok`, never `0`.
  - Output IDs (round 1): distinct spaces that share an ID (or have missing/non-string IDs that hash the same) get a `~2`, `~3`… suffix in source order, so output IDs are unique and stable for the same input.
  - Agent kind aliases: hc may report Claude Code as `agent:"claude"`; that exact value is normalized to `claude-code`. Any other unrecognized value (e.g. `Claude`, `claude-desktop`, `zsh`) is still counted as a plain terminal, not an agent.
  - tab, shell, sub-agent and ended-terminal counts
- **Fields dropped.** Never emitted: `cwd`, `folder`, `recent`, tab names, terminal names, `exit_code`, `reason`, `where` and terminal text.
- **Name sanitizing.** Names are cleaned before use:
  - control and bidi characters and `<>` and backticks are removed, and names are cut to 60 characters
  - names that look like paths (contain `/` or `\`, or start with `~`, `/` or `.`) are replaced with `未命名專案`
  - so are names that look like secrets (`sk-`, `ghp_`, `xox*-`, `AKIA`, JWT, long tokens)
  - Trade-off: a legitimate name containing `/` also falls back to `未命名專案`.
- **Status mapping.**

  | Herdr status | Shown as |
  | --- | --- |
  | `blocked` | `blocked` |
  | `done` | `review` (回合結束 · 待人工確認；不代表產品完成) |
  | `idle` | `waiting` |
  | `working` | `working` |
  | anything else | `unknown` |
  | project with no agent terminals | `none` |

  There is no "complete" state, and the output has no PR, build, deployment or acceptance claims.
- **Sort order.** Blocked first, then review, waiting, unknown, working, none.
- **Failures.** If `herdr-app ls` fails or returns output that can't be parsed:
  - `available:false` and `projects:[]`
  - the UI says "專案清單未知 … 不代表沒有專案或專案已完成"
  - the summary counts are hidden so that zeros are not presented as known values
  - Each source reports `ok`, or `error` with one of `not_found`, `timeout`, `output_too_large`, `invalid_output` or `failed`.
- **Timestamps.** The sources give no work-update time, so `updatedAt:null` and `timeBasis:"observed"`.
  - The UI shows "觀測於 YYYY/MM/DD HH:MM:SS — 時間為伺服器觀測時間，並非專案工作更新時間". The date was added in round 1 so an old snapshot is not mistaken for today's.
  - Data is marked stale after `staleAfterMs` (60s). Per-project "最後工作更新" shows 未知.
- **Shared snapshot.** One snapshot is shared by desktop and mobile:
  - 5s TTL, and concurrent requests share the run already in flight
  - `?refresh=1` is honoured only when the snapshot is at least 2s old
  - On the client, refresh is disabled while a request is in flight, the request is aborted on close, and late responses are ignored.
- **Request guard.**

  | Request | Response |
  | --- | --- |
  | not `GET` | 405 (`Allow: GET`) |
  | remote address not loopback (`127/8`, `::1`, `::ffff:127.x`) | 403 |
  | `Host` other than `localhost`/`127.0.0.1`/`[::1]` (this deliberately includes the existing `terminal.local` alias) | 403 |
  | `Origin` present but not `http://<same Host>` | 403 |
  | `Sec-Fetch-Site` other than `same-origin`/`none` | 403 |

  The adapter is middleware on the existing loopback dev server and adds no listener.
- **Disabled modes.** The endpoint returns 404 `disabled` when `VITE_PUBLIC_DEMO=true` or `AI_OFFICE_PROJECT_OVERVIEW=off`.
  - The static Sites/GitHub Pages build has no middleware at all.
  - The public-demo client never fetches and shows "公開展示版不提供專案狀態".
- **Phone access.** Access is loopback only. The UI footnote says so: "手機透過網路遠端存取尚未驗證". Phone access over the network is **deferred and unverified**.
  - No bind to 0.0.0.0, firewall, Tailscale or relay change was made.

## Checks run (exact commands and results)

Dependencies: `npm ci --no-audit --no-fund` → added 99 packages. npm warned that the `fsevents` install script was blocked by `allowScripts`; this was not changed.

Full run before the alias fix:

| Command | Result |
| --- | --- |
| `npm run test:overview` | exit 0 · tests 13 · pass 13 · fail 0 (superseded below) |
| `npm run test:integrations` | exit 0 · tests 12 · pass 12 · fail 0 |
| `npm run build` | exit 0 · `✓ built`; `dist/client/index.html`, `dist/server/index.js`, `dist/.openai/hosting.json` present |
| `npm run test:sites` | exit 0 · tests 4 · pass 4 · fail 0 |
| `node --test tests/*.test.mjs` | exit 0 · tests 27 · pass 27 · fail 0 |

Note: an earlier `node --test tests/*.test.mjs` run, made **before** the first build, failed 1 of 27. The failure was `sites-worker.test.mjs`: ENOENT on `dist/client/index.html`. That is an ordering dependency on the build, not a regression; it passed once `dist/` existed.

### Alias fix (follow-up round, before commit)

Bug: with Herdr terminal `t1` reporting `app:null` and hc reporting `address:t1, agent:"claude", status:"working"`, the adapter returned `agents:0, shells:1, status:"none"`. The fix maps `claude` to `claude-code`. Two regression tests were added: the fixture above now gives `agents:1, shells:0, status:"working", agentsByKind:{"claude-code":1}`, and unrecognized names (`claude-desktop`, `zsh`, `Claude`) still give `agents:0, status:"none"`.

| Command | Result |
| --- | --- |
| `npm run test:overview` | exit 0 · tests 15 · pass 15 · fail 0 |
| `git diff --check` | exit 0 |

As instructed for this round, no browser, network or permission changes were made; build, `test:sites` and `test:integrations` were not re-run after the fix (the fix touches only `server/project-overview.mjs` and its test).

### Round 1 fixes (after independent review of `1b9f9fd`)

Isolation note for this round:
- The build ran with a cleared environment and `AI_OFFICE_SETTINGS_PATH` pointing at a scratchpad file that does not exist.
- This matters because `vite.config.mjs` calls `loadEnvironmentConnections()` at load, so a plain `npm run build` reads the configured settings file. **Disclosure:** the earlier round-0 `npm run build` runs used the default environment. The canonical `settings.yaml` exists, so those builds probably decrypted it through the Keychain helper and may have contacted the saved provider endpoints to list models. This was not intended, and the round-0 record above did not say so.

| Command | Result |
| --- | --- |
| `npm run test:overview` | exit 0 · tests 23 · pass 23 · fail 0 |
| `node --test tests/credential-storage.test.mjs tests/notification-utils.test.mjs tests/quota-values.test.mjs tests/project-overview.test.mjs` | exit 0 · tests 33 · pass 33 · fail 0 |
| `env -i PATH HOME AI_OFFICE_SETTINGS_PATH=<scratchpad>/empty-settings.yaml node ./node_modules/vite/bin/vite.js build && node scripts/prepare-sites-build.mjs` | exit 0 · `✓ built`; `dist/client/index.html`, `dist/server/index.js`, `dist/.openai/hosting.json` present |
| `npm run test:sites` | exit 0 · tests 4 · pass 4 · fail 0 |
| `git diff --check` | exit 0 |

Not run this round, as instructed: `npm run test:integrations` (live integrations), the browser, the network, and the dev server.

### Live checks against the endpoint

These ran on an isolated dev server (`127.0.0.1:4188`). `AI_OFFICE_SETTINGS_PATH` pointed at a scratchpad file that does not exist and the environment was cleared, so no saved credentials or Keychain were read.

| Request | Result |
| --- | --- |
| `GET` | 200 · `available:true`, both sources `ok`, local projects listed (blocked first); the body contained no `/Users` or `cwd` |
| `POST` | 405 `method_not_allowed` |
| `Origin: http://evil.example` | 403 `origin_not_allowed` |
| `Sec-Fetch-Site: cross-site` | 403 `cross_site` |

A server with `PATH=/usr/bin:/bin` (Herdr CLIs not reachable) returned 200 with `available:false`, both sources `error/not_found`, and `projects:[]`.

### Browser checks (ego-browser, viewport set with CDP)

These were run by the implementer in round 0, against the round-0 code, and have **not been independently verified**. They were not re-run after the round-1 fixes; the round-1 UI changes (focus trap, unknown identity and ended rendering, dated timestamp) are covered only by pure unit tests of their helpers.

- **390×844 mobile:**
  - the panel fills the 390px width with no horizontal page scroll
  - clicking a project opens its detail view
  - Escape closes the panel, returns focus to the trigger, and leaves the office map in place
  - Top bar: the new button first made `連接來源` wrap (42px tall vs 29px without it). After the ≤480px CSS fix it measures 29px on one line, with no overflow.
- **Unknown sources (390×844):** shows "專案清單未知"; the summary counts are hidden.
  - Five quick refresh clicks produced **one** request, because the button is disabled while a request is in flight.
- **Public demo** (`VITE_PUBLIC_DEMO=true` build into the scratchpad, served by `vite preview` on 4190):
  - shows "公開展示版不提供專案狀態"
  - makes no request
- **Desktop 1440×900:** 430px drawer on the right, with the island map still visible.
- **Storage:** checks used separate loopback ports (4188/4189/4190), so browser storage was per origin and the canonical app's storage was not touched.
- **Screenshots:** kept only in the session scratchpad. They show real local project names and are **not** committed.

## Not done / remaining acceptance

- Independent reviews: see the review round ledger below. The round-1 fix commit needs both providers to review the same new SHA.
- **Real-phone acceptance is deferred**, as is access over a private secure route: unverified and not authorized. All mobile evidence comes from a 390×844 desktop-browser viewport.
- No automated UI component test runner exists in the repo. UI loading, retry, offline and race behaviour was checked manually in the browser, as listed above.

## Review round ledger

### Round 1 — candidate `1b9f9fd069333580c3a91bff0ef142cde9ed0b76`

Reviewers, as reported to the implementer by the user's workflow: Codex, and a separate Claude session (t21). The implementer did not see their raw transcripts and records the findings as relayed.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | When hc fails or returns invalid output and Herdr gives no `app`, the terminal was counted as a shell, so the project showed "no agents"/`none`; ended counts showed `0` | **Fixed.** Such terminals are now `unidentified` and `unknown`; `ended` and `unattributedEnded` are `null`; the UI shows 代理身分未知 / 身分未知終端 / 未知（hc 無法讀取）. Tests: failed (timeout, not_found), invalid (non-JSON, wrong shape) and missing hc fixtures; Herdr-app identity is still trusted when hc fails; UI label helpers. |
| 2 | Distinct spaces with duplicate valid IDs produced duplicate React keys, and the second project's detail opened the first | **Fixed.** Output IDs are made unique in source order (`~n` suffix). Tests cover duplicate, colliding-suffix, number vs string, missing and object IDs, plus stability. Also fixed while here: ended-count attribution used indexes into the unfiltered space list, so a `null` space shifted ended counts to the wrong project (test added). |
| 3 | `aria-modal` dialog had no Tab focus trap | **Fixed.** Tab and Shift+Tab wrap inside the panel, and focus that has escaped is pulled back. Escape-to-close and focus return to the trigger are unchanged. The decision logic is a pure helper with unit tests; the trap itself has not been verified in a browser. |
| 4 | Unattributed ended terminals were not shown; the observed time had no date | **Fixed.** The list shows "另有 N 個已結束終端無法對應到單一專案", or explains that the count is unknown when hc is unavailable. The observed time now includes the date. |

Round 1 result: findings, so not a clean review. The fix commit, which contains this file and whose SHA it therefore cannot quote, becomes the **round 2 candidate**. Both Codex and Claude must review that same SHA. Rounds used: 1 of 5.
