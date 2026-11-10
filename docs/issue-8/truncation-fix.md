# Issue #8 follow-up: project overview truncation

Base: `main` at `2e1dfb6f504ae68534f3ec77b8088c586ca50662` (PR #10 merged).

## Findings

| # | Finding | Effect before fix |
|---|---------|-------------------|
| 1 | `herdr-app ls` spaces were sliced to `MAX_PROJECTS` (100) in source order, before the status sort. | With 101 spaces, a blocked 101st project vanished; the summary and list looked complete. |
| 2 | `hc ls --all --json` terminals were sliced to `MAX_TERMINALS` (500). | With 501 finished terminals, ended totals reported 500 as if complete. |
| 3 | Per-terminal `sub_agents` were capped at 50 with `Math.min`. | Sub-agent counts above 50 were understated silently. |
| 4 | The project slice ran before filtering invalid entries, and name-based ended attribution only knew kept spaces. | Invalid entries consumed cap slots; a finished terminal whose space name matched an omitted space could be attributed to a kept space with the same name. |

## Plan and disposition

All three safety bounds stay unchanged. Nothing past a bound is processed; it is reported.

- Adapter (`server/project-overview.mjs`)
  - Exports `MAX_PROJECTS`, `MAX_TERMINALS`, `MAX_SUB_AGENTS_PER_TERMINAL`.
  - Filters invalid spaces before applying the project cap.
  - Adds `partial` (boolean) and `truncation: {projects, terminals, subAgents}`; each is `null` unless that bound was hit. `projects`/`terminals` carry `{limit, total, omitted}`.
  - Per project: `endedPartial` (hc list was capped, so `ended` is a lower bound) and `subAgentsPartial`.
  - Snapshot: `unattributedEndedPartial`.
  - Name uniqueness for ended attribution covers all valid spaces, so a name shared with an omitted space stays unattributed.
  - A failed source never reports truncation for data it did not read; a failed hc still yields `ended: null` (unknown).
- Utils (`src/project-overview-utils.mjs`): `truncationNotes`, `omittedProjects`, `endedLabel`, `subAgentsLabel`; `unattributedEndedNote` states the lower bound.
- UI (`src/ProjectOverview.jsx`, `src/styles.css`): an amber “資料不完整” banner lists each truncation; summary counts get a `+` suffix and a note that omitted projects have unknown status; detail view shows “至少 N” for ended and sub-agent counts.
- Tests (`tests/project-overview.test.mjs`): 100/101 projects, 500/501 hc terminals, 50/51 sub-agents, invalid-space cap accounting, omitted-name attribution, hc failure, Herdr failure.

## Review round 1 (`f90c44e`)

Two independent reviewers (Codex and Claude) reported the same findings. All are fixed:

| Finding | Disposition |
|---------|-------------|
| P3: array entries in `spaces` passed the object check and used up project cap slots as fake projects. | `validSpaces` now excludes `Array.isArray`. The fixture adds `[]` and `[{id}]` before 100 real spaces and expects 100 projects with no truncation. |
| P3: the hc truncation warning only covered ended totals. Live terminals past the cap get no hc identity or status fallback. | The warning now also says that terminals past the cap, if Herdr gives no agent type or status, show unknown identity and status. The fixture uses 500 finished terminals plus a live, blocked `claude` terminal at position 501, with Herdr app/status missing. Expected result: the project is `unknown` with 1 unidentified terminal and no blocked count. At position 500 (within the cap) the same terminal resolves to blocked. |
| Accessibility: `aria-label` on a plain `div` summary is not reliably announced. | Added `role="group"`. |

## Verification

- Round 0 (`f90c44e`): `project-overview` 31/31 pass. `sites-worker` 3/4 pass; 1 fails with `ENOENT dist/client/index.html` because there was no build.
- Round 1: `node --test tests/project-overview.test.mjs` 32/32 pass. `node --test tests/sites-worker.test.mjs` 4/4 pass against the `dist/` the coordinator built from `f90c44e`, not from this round's commit. A syntax-only esbuild JSX transform of `src/ProjectOverview.jsx` succeeds.
- The coordinator built `f90c44e` with `env -i`, a nonexistent `AI_OFFICE_SETTINGS_PATH`, and an ignored `node_modules` symlink to existing installed deps. Nothing was installed. That build evidence applies to `f90c44e` only.

## Limitations

- Which projects are kept is still source order, not priority: an omitted project may be blocked. The UI says so instead of reordering, because ranking needs every space processed, which the cap exists to avoid.
- This round ran no build, browser, live Herdr/hc, network, integration or settings step. The UI change has not been checked visually, and `dist/` does not reflect the round-1 commit.
- Rollback: revert the commit; the snapshot change is additive (new fields only), so older clients ignore them.
