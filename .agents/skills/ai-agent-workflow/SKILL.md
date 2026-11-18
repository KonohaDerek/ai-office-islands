---
name: ai-agent-workflow
description: Plan and review cross-platform agent work with confirm-first routing, safe model selection, PR evidence, and release synchronization.
---

<!-- aaw:managed:start -->
## Operating mode

Follow the repository's `AGENTS.md`, `routing/policy.json`, and the skill for the current phase. Work in confirm mode. A plan or dry run does not launch an agent, edit settings, synchronize a skill, create a PR, merge, publish, deploy, or dispatch an issue.

Keep bounded work with the main agent. Delegate only large work with independent scopes, no dependencies, and no shared-file conflicts. A Coordinator decides whether work is authorized. Codex Route Advisor is advisory only.

## Routing and models

Classify work by task type, scope, risk, dependencies, and uncertainty. Use Luna for bounded tasks, Terra for ordinary multi-step work, Sol for complex work and independent workers, Astra for explicit high-risk or hardest end-to-end work, and Sol as the uncertain-classification fallback. A platform model is only a candidate until the installed CLI supports model selection and the user confirms the account can access that model. Otherwise preserve the active host default. A route plan never invokes the provider.

Use Jev only when the official skill is already installed, `TYPESAFE_API_KEY` is present, a host transport exists, and an explicitly approved health/auth check is known to be no-charge. Check key presence only; never print, persist, or include its value in logs, reports, or release snapshots. Missing key, transport, or safe approved check falls back without a Jev call. Rejected or unauthorized requests fall back without retry; disconnected transport may be reported as retryable, but never retry automatically. Unknown outcomes and empty results fall back without retry. Record a safe reason and use the active host default. Do not invent Jev endpoints or authentication behavior.

## Review and PR evidence

For medium or large changes, record requirements, design, dependencies, acceptance checks, and rollback. Verify build, lint, type, unit, and applicable integration/UI checks. Review bug, security, and independent context separately. Bind evidence to the current full commit SHA; after a change, rerun affected checks and reviews. Keep the five-round correction cap. Human approval and branch protection remain separate requirements.

`PYTHONPATH=scripts python3 -m aaw.cli pr-check` and `queue-check` evaluate only supplied local JSON snapshots. They do not read GitHub or authorize a merge. A passing pre-merge result still requires a human final decision. A next issue is only proposed after a confirmed merge, main CI and smoke success, and resolved dependencies; the evaluator never dispatches it.

## Release and skill sync

Consume only a published stable release installed by the repository bootstrap. Review the `release-sync` dry-run before any write. Sync only the workflow skill's managed block, preserve text outside its markers, stop on conflicts, and keep a rollback backup. Apply requires an explicit interactive confirmation. Never overwrite the six existing skills or user-owned configuration.

## Platform boundaries

The bundle provides Codex, Claude Code, Hermes, and GitHub Copilot CLI guidance. Provider model IDs, account access, and optional integrations must be checked on the target platform. This skill does not implement an agent dispatcher or change user settings.
<!-- aaw:managed:end -->
