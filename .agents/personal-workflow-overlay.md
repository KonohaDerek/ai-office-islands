# Personal project planning, implementation, and review overlay

This policy supplements the project's existing `AGENTS.md`, workflow skills,
and release-pinned workflow. Release-based roles and independent two-provider
review apply to personal projects on both the Mac mini and MacBook Pro.
The five-round limit and autonomous merge/release permissions below apply only
to the Mac mini. Company projects and Bitfinex canonical Git remain excluded.
Project instructions and later user decisions continue to apply.

## Precedence and limits

For authorized Mac mini personal projects, this overlay supersedes only the
generic bundled two-round cap and additional conversational confirmation before
merge/release, plus the scoped proposal permission and exact LightSpeed OpenSpec
exception below. The written user authorization and the gates below must both
be satisfied. Only copies verified byte-identical to published generic bundle
defaults are superseded. Customized or project-authored restrictions remain
binding inside or outside personal-aaw markers, except that the named LightSpeed
exception supersedes an OpenSpec-only requirement for that exact project. If
identity is uncertain, keep the restriction. This does not override unrelated
project-specific restrictions, branch protection, required checks, platform,
system or security rules, or deployment approval. On the MacBook Pro, retain
the applicable baseline round cap and request confirmation for merge/release.

On both personal Macs, the proposal section below also supersedes generic
bundled confirmation for opening proposal issues and discussing them in the
same authorized project tracker, subject to every limit in that section.
This does not authorize PR creation, unrelated tracker changes, editing or
closing others' issues, company/Bitfinex work, or other remote mutations.

The published stable v2.2.0 bundle remains unchanged. Its pr-check and
queue-check remain snapshot-only baseline evidence evaluators, not dispatchers
or authorization. They still report the baseline two-round/confirmation policy.
Do not claim a failed baseline check passed: record the result and separately
evaluate only the explicitly superseded generic policy gates against this
overlay and the user authorization. All other failures still block delivery.

## Route each task from project release evidence

At task start, determine whether the project itself has a verifiable, formally
published stable release. Use the project's authoritative release source (for
example, its official GitHub Releases page or equivalent official registry) and
record the source, release identifier, publication state, and lookup time in the
task plan or work log.

- A published, non-draft, non-prerelease stable release means **Claude plans**
  and **Codex implements**.
- A successful check of the authoritative source that finds no formally
  published stable release means **Codex plans** and **Claude implements**.
- Drafts, prereleases, and tags without evidence of a corresponding published
  stable release do not count as a stable release.
- If the authoritative source cannot be read, the evidence conflicts, or the
  publication state cannot be verified, record the state as **unknown** and
  stop the role assignment pending a reliable check. Never infer “no release”
  from a failed or incomplete lookup, a workflow bundle's own version, or a
  package `VERSION` string.

Lock the selected route and its evidence at task start. Do not switch planning
or implementation roles automatically if a release appears or the evidence
changes during the task. Change the route only when the user explicitly
requests it, and record the reason.

## OpenSpec exception: LightSpeed.Component.Model.V3

For a project whose canonical repository or project identity is exactly
`LightSpeed.Component.Model.V3`, skip the OpenSpec workflow and do not invoke
the OpenSpec skill or create/update OpenSpec change artifacts. Use a concise
task brief that records the goal, scope, acceptance checks and required tests
instead. This explicit user exception overrides OpenSpec requirements from the
generic workflow or project-specific instructions for this exact project only;
project-release provider routing, isolated worktrees, authorization,
implementation scope, independent reviews, validation, and delivery gates still
apply.

Apply this exception only when the project/repository identity itself matches
the exact name; do not match a substring, dependency, folder elsewhere in a
repository, or similarly named project. If identity is ambiguous, verify it
from authoritative project metadata before skipping OpenSpec. For every other
project, keep using OpenSpec whenever required by the existing workflow or
project instructions. Do not remove, weaken, or globally disable OpenSpec.

## Permit feature proposals and discussion issues

Claude, Codex, and Hermes may open and discuss feature-proposal issues in an
authorized personal project. Before opening an issue, search that project's
existing issues for duplicates. Record the user need, expected value, proposed
scope and non-goals, and a suggested verification method. Clearly label the
issue as a proposal and identify the actual provider/author; never fabricate a
provider's participation or comments.

An issue or discussion is a proposal only. It does not authorize implementation,
add work to the current roadmap, count as acceptance, or expand a release's
scope. Implement proposed work only after it is explicitly selected into an
authorized task or roadmap. Do not create an issue or send discussion messages
outside the authorized personal project, and do not include sensitive data or
expand company-project or Bitfinex canonical no-touch scope. Use only the
platforms and repository permissions already available; do not bypass access
controls. This standing issue permission does not direct creation of an issue
for every task.

## Implement only the authorized scope

The provider assigned by the release-based route may implement autonomously
within the user's authorized task and its explicit roadmap scope. Keep proposal
discussion separate from implementation authorization. Preserve project-specific
worktrees, checks, data boundaries, and safety requirements.

## Require independent, two-way review

For every implementation, real Codex and real Claude reviewers must each
independently review the same final diff or commit SHA. The implementation
session cannot approve its own work. Record both reviewer identities, actual
provider, exact diff/commit SHA, review scope, findings, and resolution status
in the task evidence. One provider cannot be relabeled as the other, and Hermes
cannot substitute for either required reviewer. Do not fabricate provider
calls, review records, approvals, or results. If a provider or required
reviewer is unavailable, record the blocker and leave that review incomplete.

Select additional specialist roles based on the change, such as architecture,
security, data or transaction consistency, testing, performance, or UI/UX.
State why each role applies and link its findings to the same diff/commit. A
role label is not proof that a real specialist or provider was called.
Every finding must have an owner, evidence and disposition. A finding is
resolved only when the fix is verified by both reviewers on the current SHA,
or both reviewers document why it is a false positive. Merely tracking or
deferring a finding does not resolve it and blocks autonomous merge/release,
including lower-severity findings. Any risk-acceptance exception requires a
separate explicit user decision; this policy grants no such exception.

### Review-round limit

Maintain one durable round ledger across sessions, agents and role splits.
Authoritative evidence lives outside the reviewed tree, keyed by full SHA,
with capture time, provider/model (unknown if unavailable), reviewer session,
severity and file:line findings, dispositions, commands and exit statuses.
In-repo ledger text is a frozen historical snapshot, not a live approval record.
A round is exactly the two independent provider reviews of one immutable
candidate SHA. Fixing a finding creates a new candidate SHA and the next round;
correction and re-review are not counted inside the preceding round. Record
the round number, full SHA, providers, findings, dispositions, fix SHA and
closure state. Do not reset or split the count by opening another session or PR.

On the Mac mini, at most five candidate review rounds may complete. If round
five still requires a fix, stop before creating candidate six or beginning a
sixth review/fix round and ask the user to decide. Every changed candidate,
including a changed merge/release candidate, requires both providers to review
that new SHA. On the MacBook Pro retain the applicable baseline round cap;
the Mac mini-specific five-round grant does not expand that scope.
A changed merge SHA consumes the next round even after a clean fifth round:
stop and ask the user before that sixth review or release. No tree-identity
exception applies. An allowed fast-forward retaining the exact reviewed SHA
requires no new round; do not change repository settings to obtain one.

## Mac mini only: merge and release gates

The user authorizes an agent to perform a manual merge of an in-scope
personal-project PR without another confirmation only after all of the
following are verified. This is not permission to enable automatic merging:

- real Codex and Claude reviews both cover the same current head SHA;
- the current head still equals that reviewed SHA;
- required CI and project checks pass on that head;
- no unresolved review findings or merge conflicts remain; and
- repository branch protections and all platform, system, security, and
  repository rules are satisfied without bypass.

If any condition fails or cannot be verified, do not merge. Proposal issues and
review discussion do not authorize a merge. A merge is not roadmap acceptance,
release, deployment, or user acceptance.

The precedence section applies only to generic bundled confirmation defaults.
Project-specific stricter requirements, platform controls, system/security
restrictions and branch protection remain mandatory; never bypass them.

The user authorizes release publication only for a roadmap whose scope has
recorded user approval. An agent-created checklist cannot approve its own scope.
Every approved roadmap item must be complete with required validation evidence.
The exact release candidate SHA must be a merged commit independently reviewed
without unresolved findings by both real providers and have passing required CI
and project checks on that same SHA. A squash/merge commit that differs from
the reviewed PR head needs its own reviews and checks before release. Any later
commit invalidates earlier candidate evidence and consumes the next review round.
Verify release contents and tag target against that SHA immediately before
publication. A merged PR alone proves neither roadmap completion nor acceptance.
Do not deploy; deployment requires its own explicit authorization.

These autonomous merge and release permissions apply only to the authorized
Mac mini personal-project scope. They do not transfer to the MacBook Pro or
another device. Company projects and Bitfinex canonical Git remain out of scope.
