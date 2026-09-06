---
type: Operations
title: Drift Governance (crctl) & Workspace Setup
description: Code-level drift governance for standalone IDE usage — the crctl CLI (read/single-file subcommands plus durable deep primitives), outbox event channel, unified evidence digest, dual-track approval (TTY + ed25519 grants), controlled-shell rules.json, IDE adapters, and CI guard layers.
tags: [operations, drift-governance, crctl, controlled-shell, evidence-digest, approval, outbox, setup]
openwiki:
  roles: [operations, architecture]
  change_kinds: [lifecycle, public-api, governance]
  source_paths:
    - skills/shared/crctl/scripts/crctl.mjs
    - skills/shared/crctl/gates.json
    - skills/shared/controlled-shell/rules.json
  symbols: [cmdStatus, cmdAdvance, cmdApprove, cmdReviewRecord, cmdCheckpoint, cmdMerge, cmdWritebackApply, cmdArchive, canonicalEvidenceDigest, controlledGit]
  test_paths:
    - skills/shared/crctl/scripts/test/crctl.test.mjs
  invariants:
    - CR status is written only through crctl advance into cr.md frontmatter.
    - Human approval is only via crctl approve (interactive TTY or Ed25519 grant); non-TTY is refused.
    - git is authoritative; the outbox is a projection that never blocks the main operation.
  validation_commands: ["node --test skills/shared/crctl/scripts/test/crctl.test.mjs"]
---

# Drift Governance (crctl V2) & Workspace Setup

When the Phase0 tools package is used on the AI First platform, the platform's progressive loading, pipeline execution constraints, and controlled-shell adapter enforce the rules. When used standalone in IDEs (Claude Code, Cursor, Codex, Kimi, Qoder), these rules degrade to model self-enforcement — and the model drifts.

This page explains the drift problem, the governance solution (`crctl` V2), the layered enforcement architecture, and how to set up a workspace for reliable standalone usage.

## Why Drift Happens

The tools package's constraints are **document-level and prompt-level**. Rules are written in `AGENTS.md`, `dir-graph.yaml`, `SKILL.md` files, and pipeline JSON — but the executor is the AI model itself.

- With the platform: rules are enforced by code (progressive loading, pipeline execution engine, shell adapter)
- Without the platform: rules depend on the model "remembering" them across long conversations, context compression, and multi-turn handoffs

The root cause is not that the rules are poorly written — it's that **rules lack a code-level executor** in standalone mode.

## The 10 Drift Points

`docs/漂移治理_v2.md` identifies 10 specific ways the model drifts when used standalone:

| # | Drift Point | Manifestation |
|---|------------|---------------|
| ① | CR-ID & status pointer loss | Model guesses status from memory instead of reading `cr.md` frontmatter |
| ② | Verbal approval (bypassing writes) | Model says "approved" without writing evidence files |
| ③ | Git outside controlled-shell | Model runs arbitrary git commands, not whitelisted ones |
| ④ | Missing execution constraint layer | No enforcement of `agent-skill-matrix.yml` boundaries |
| ⑤ | Human approval bypassed by model | Model self-confirms `human_approval` nodes |
| ⑥ | Direct writes to baseline (`specs/`) | Model writes straight to `specs/{id}/` bypassing writeback |
| ⑦ | Non-git write drift | Model writes to protected paths via Write/Edit/Bash tools |
| ⑧ | Review-loop counter drift | Model forgets to increment or persist `review-loop.current-attempt` |
| ⑨ | Artifact schema drift | Fields, enums, and structures subtly degrade over long conversations |
| ⑩ | Metadata hallucination | Model invents timestamps and identities for owner-history, checkpoints |

## Enforcement Layers

The drift governance system uses a four-layer defense:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **1. crctl CLI** | Code-level state machine, gate checks, CAS writes | Cross-IDE (universal) |
| **2. Claude Code hooks** | PreToolUse guard (block raw git + protected writes); context injection | Claude Code |
| **3. CI remote gate** | `crctl gate` + `crctl validate` on `requirement/*` branches | GitHub Actions |
| **4. Prompt fallback** | `AGENTS.md`, `SKILL.md` constraints as last-resort guidance | Hook-less IDEs |

Layers 1-3 are code enforcement. Layer 4 is the original prompt-level defense, kept as a fallback for IDEs without hook support.

## The Solution: `crctl`

`crctl` is a zero-dependency Node.js CLI (`skills/shared/crctl/scripts/crctl.mjs`, requires Node ≥ 18, `node:*` built-ins only) that replaces model self-enforcement with code enforcement. The CLI/gate logic stays in `crctl.mjs`, while cross-file and cross-repo writes are delegated to a transaction layer — see [crctl transactions & deep primitives](/openwiki/operations/crctl-transactions.md).

The command surface is grouped into three tiers:

### Tier 1 — Read-only & single-file CAS

| Subcommand | Purpose | Replaces |
|------------|---------|----------|
| `status` | Reads `cr.md` frontmatter (the **status authority**) + state machine; outputs current status, legal next steps, gate gaps, and `STATUS_DIVERGED` when the worktree view disagrees | Model-guessed status (drift ①) |
| `next` | Reads status + review/test evidence → outputs the next node to run; never returns `human_approval` if blockers remain | Minimal pipeline runner (drift ④) |
| `gate` | Validates without writing — for pre-checks and CI; emits EVIDENCE_DRIFT audit events | Pipeline `passCondition` (drift ②) |
| `advance` | Validates `(current, next, trigger)` transition + gate checks; writes `cr.md` frontmatter only if all pass; CAS-based; emits outbox status event | `cr-status-set` (drifts ①②⑧) |
| `attempt` / `review-loop reset` | `attempt` is the sole counter for review-loop attempts (reads `maxAttempts` from pipeline JSON; `LOOP_EXHAUSTED` when exceeded). `review-loop reset` is the TTY-only human reset to the next cycle with audit | `reviewLoop.maxAttempts` (drift ⑧) |
| `test` | Runs lint/test/build commands with real exit codes; generates `test-report.md` skeleton (status/tester/commands are tool-generated); raw output to `test-evidence/` | `write-test-report` (drift ②) |
| `validate <file>` | Schema validation for `cr.md`, `_backlog.yml`, `test-report.md`, `approval.yml` (incl. server-approve signature re-verification), `traceability.yml`; emits EVIDENCE_DRIFT audit events | `validate-doc` (drift ⑨) |
| `git` | Whitelisted git adapter with ternary authorization (subcommand + form + caller) from `rules.json`; `FORBIDDEN_SUBCOMMAND` / `SHELL_UNAVAILABLE` on violations; full audit log; checkpoint outbox events on push | `controlled-shell` (drift ③) |
| `report` | Read-only CR metrics / aggregation | ad-hoc dashboard scripting |

### Tier 2 — Human approval & review evidence

| Subcommand | Purpose | Replaces |
|------------|---------|----------|
| `approve` | **Dual-track**: TTY interactive (human confirms → writes `approval.yml` → cascading advance) or `--grant` server-signed (ed25519 verification + evidence digest re-computation); `--resign` for controlled resign of a prior approval. Non-TTY without `--grant` returns `APPROVAL_REQUIRES_HUMAN` | `human_approval` + `approve-*` (drift ⑤) |
| `review-record` | Writes canonical review verdict/blockers/suggestions to `review-annotations/{stage}.yml` + `traceability.yml`, with machine-injected `subject-sha256` digest and (for code) `release-subjects`; only `reject`/`withdraw` advance terminal state | hand-written review YAML |
| `review-note` | Appends supplemental review notes without a write path into the four approval sections | `cr-review-record` legacy notes |

### Tier 3 — Deep primitives & ledger writes

These own cross-file and cross-repo Git/ledger algorithms and are idempotent/recoverable. Detailed in [crctl transactions & deep primitives](/openwiki/operations/crctl-transactions.md):

| Subcommand | Purpose |
|------------|---------|
| `register` | Atomic CR registration (`cr.md` + `_backlog.yml` + `_index.yml`, `--target-version`, `--origin`, three-role owners) then per-repo worktree creation |
| `checkpoint` | Full-repo source commit → non-KB lease publish → KB `latest-checkpoint` + metadata commit (single visibility point) |
| `workspace inspect\|ensure\|cleanup\|freshness\|sync` | Classify/restore/clean CR worktrees; freshness classification and explicit ff-only sync |
| `merge [status]` | Per-repo merge-tree + synthetic `_backlog.yml` merge, finalize, establish `operationalWorkspace` |
| `writeback-apply` | Candidate-only writeback of baseline/tasks/traceability; baseline + `writing-back` published in one batch |
| `archive` | Move CR to `_history.yml`, update `cr.md` status, clean worktrees/refs |
| `upgrade-check` | Read-only temporary pre-check for the release-snapshot protocol switch (safe/requiresReapproval/blocksUpgrade) |
| `task init\|append\|done` | Task index lifecycle: allocate TASK-ID, append, mark done (with `depends-on` guard) |
| `owner-set` / `version-set` / `backlog-set` / `inbox-emit` | Ledger-transaction field writes (owner handoff, `unassigned → real` version correction, whitelisted backlog fields, inbox events) |

### Key Design Principles

- **Single source of truth**: `crctl` reads state transitions from `dir-graph.yaml` and pass conditions from pipeline JSON at runtime. Gate mappings are in `gates.json`. Controlled-shell rules are in `rules.json`. No rule duplication.
- **Authority separation**: The model can generate tokens, but authoritative state only changes through `crctl` writes; `cr.md` frontmatter is the status authority, and `_backlog.yml` is a registration index (no longer the status source).
- **Timestamps and identity**: All timestamps and executor identities are generated by `crctl` from system clock and configured identity — the model cannot pass them in.
- **CAS / durable writes**: single-file writes use hash-CAS; multi-file and cross-repo writes use the [durable transaction layer](/openwiki/operations/crctl-transactions.md).
- **Zero external dependencies**: The entire CLI and its `lib/` use only `node:` built-in modules (fs, path, crypto, readline, child_process).

### Usage

```bash
node tools/skills/shared/crctl/scripts/crctl.mjs status CR-2026-001
node tools/skills/shared/crctl/scripts/crctl.mjs advance CR-2026-001 --to code-reviewing --trigger review-code
node tools/skills/shared/crctl/scripts/crctl.mjs approve CR-2026-001 --stage code  # human only, in terminal
node tools/skills/shared/crctl/scripts/crctl.mjs approve CR-2026-001 --stage code --grant  # server-signed grant
node tools/skills/shared/crctl/scripts/crctl.mjs register --title "..." --target-version 1.2.0
node tools/skills/shared/crctl/scripts/crctl.mjs git status --short --cwd <worktree>
```

Use `--workspace <path>` for explicit workspace targeting; by default, `crctl` resolves the installation root from `dir-graph.yaml#repositories`.

## Outbox Event Channel

The outbox is a local event projection channel (`crctl advance` success → status event; `crctl git push` success → checkpoint event). Events are written atomically (tmp + rename) to `.crctl/outbox/` as JSON files for a daemon to collect — `crctl` itself never talks to the network.

| Event Kind | Trigger | Key Fields |
|------------|---------|------------|
| `status` | `crctl advance` success | `cr_id`, `from_status`, `to_status`, `trigger`, `commit_sha`, `actor`, `evidence` (digest snapshot for approval-pending stages) |
| `checkpoint` | `crctl git push` success (CR-related) | `cr_id`, `commit_sha` (resolved HEAD), `payload.pushed`, `payload.headMessage` |
| `audit` | `crctl gate` / `validate` detects EVIDENCE_DRIFT | `cr_id`, `stage`, `expected_digest`, `actual_digest`, `detected_at` |

**Event idempotency**: Status events in `--embedded` mode use `pendingCommitSha()` (process-unique placeholder with `pending:` prefix) to avoid `cr_sync_event` key collisions — the server daemon fills in the real commit SHA when it sees the follow-up checkpoint event.

**Windows safety**: Outbox filenames are sanitized (colons replaced) for Windows file system compatibility. Event content is never altered.

## Unified Evidence Digest & Dual-Track Approval

### Canonical Evidence Digest

The `canonicalEvidenceDigest()` function in `crctl.mjs` is the **single implementation** of evidence hashing. It:
1. Collects all evidence files declared in `gates.json#approvalStages[stage].evidence`
2. Computes `sha256(line-normalized content)` for each file (normalizing `\r\n` → `\n` to avoid autocrlf false positives)
3. Concatenates hex digests in path-sorted order and computes an overall `sha256`

The deprecated `evidence-sha256-16` field (single-file short hash) is still recognized for backward compatibility with historical approvals (M0 vintage) but does not block advancement.

### Dual-Track Approval

`crctl approve` supports two tracks:

**Track 1 — TTY Interactive** (`via: crctl-approve`):
- Detects stdin/stdout TTY; non-TTY returns `APPROVAL_REQUIRES_HUMAN` with no bypass
- Displays evidence summary (pass/fail per condition, file existence checks)
- Prompts `[yes/N]` — `y`/`yes` (case-insensitive after trim, CR-2026-044) writes `approval.yml`
- Computes and stores canonical evidence digest
- Triggers cascading `advance` to the target status

**Track 2 — Server-Signed Grant** (`via: server-approve`):
- `--grant` flag accepts a path to a `.grant.json` file (or defaults to `.crctl/grants/{cr}-{stage}.grant.json`)
- Re-computes canonical evidence digest locally; rejects if it differs from the grant's `evidence_digest`
- Verifies ed25519 signature against the canonical string `v1|{cr_id}|{stage}|...` using the public key at `.crctl/keys/{key_id}.pub`
- Rejects grants with mismatched `cr_id`/`stage`, invalid signatures, or `decision=reject`
- Writes full grant metadata (`key-id`, `signature`, `grant-approved-at`) into `approval.yml`

Both tracks are recognized by `crctl gate` and `crctl validate` as valid approval sources.

### EVIDENCE_DRIFT Detection

Every `crctl gate` and `crctl validate` invocation re-computes evidence digests and compares against stored approval records. On mismatch, it:
1. Returns `EVIDENCE_DRIFT` as the gate failure reason
2. Emits an `audit` outbox event with deterministic dedup naming (`audit-drift-{cr}-{stage}-{expected8}{actual8}.json`)

This ensures tampering with evidence files after approval is detected and logged before any further state advancement.

## Delivery Index Consistency

The `deliveryIndexComplete` gate check (`gates.json#statusGates.archived`, CR-2026-005) validates that every `status=done` task in `change-requests/{cr}/tasks/_index.yml` has a corresponding entry in the global `delivery/task/_index.yaml`. This prevents partial writeback — a CR cannot be archived if some completed tasks were never written back to the team's delivery index.

## Controlled Shell

The controlled-shell system enforces a whitelist-based git adapter. The **single source of truth** is `skills/shared/controlled-shell/rules.json` (43 lines, v1 schema), consumed by both `crctl.mjs` and `pretooluse-guard.mjs`. The `SKILL.md` file has been demoted to commentary only.

### rules.json Structure

| Section | Content |
|---------|---------|
| `git[]` | 19 git subcommands, each with `sub`, `shapes[]` (JS RegExp sources or `{re, flags}` objects), and `callers[]` |
| `forbiddenFlags[]` | 6 flags blocked across all subcommands: `-c`, `-C`, `--exec`, `--upload-pack`, `--receive-pack`, `--config-env` |
| `protectedPaths.deny[]` | 6 regex patterns for paths crctl owns exclusively (backlog, cr.md, approval.yml, review-loop.yml, review-annotations) |
| `protectedPaths.ask[]` | 3 regex patterns for paths that require human confirmation (specs baseline, delivery, test-report) |

Key rules:
- All git commands must go through `crctl git` — raw git in an IDE terminal is prohibited
- If `rules.json` is missing or corrupt, `crctl git` returns `SHELL_UNAVAILABLE` (never silently allows)
- Git commands are executed with `GIT_EDITOR=true EDITOR=true GIT_TERMINAL_PROMPT=0` to prevent interactive prompts

### RE2 Compatibility

The controlled-shell regex shapes are [RE2-compatible](https://github.com/google/re2/wiki/Syntax) to support Go's `gitguard` (which uses RE2, not PCRE). The `(?!...)` negative lookahead originally used for `add` shapes was replaced with the equivalent character class `^[^-].*$` for cross-engine parity.

## IDE Adapters

### Claude Code

`skills/shared/crctl/adapters/claude-code/` provides:

| Component | File | Purpose |
|-----------|------|---------|
| PreToolUse guard | `hooks/pretooluse-guard.mjs` | Blocks raw `git` commands, writes to `protectedPaths.deny`, Bash redirects; reads `rules.json` for path patterns |
| Context injection | `hooks/inject-cr-status.mjs` | Auto-injects `crctl status` output on SessionStart and PreCompact |
| Settings template | `settings.template.json` | Drop-in hooks configuration for Claude Code |

### CI Guard

`skills/shared/crctl/adapters/ci/cr-guard.template.yml` is a GitHub Actions template that runs `crctl gate` and `crctl validate` on `requirement/*` branches — providing a server-side enforcement layer that even hook-less IDEs cannot bypass.

The repository also has a [CI guard workflow](/openwiki/operations/ci-guards.md) (`check-skill-matrix.yml`) that runs contract integrity checks on every push and PR.

## Workspace Prerequisites

To use the Phase0 tools package, a workspace must have:

| Prerequisite | Description |
|--------------|-------------|
| `AGENTS.md` | AI behavior constraints entry point |
| `dir-graph.yaml` | Directory graph with `#repositories` declaring active repos and trunks, plus `agents.contract` invariants |
| `change-requests/` | In-flight CR directory with `_backlog.yml` and `_index.yml` |
| `specs/` | Baseline PRD/SDD/traceability directory |
| `delivery/` | Delivery task directory |
| `docs/` | Market insights, competitive, product planning, feedback, ideas, references |
| `agent-skill-matrix.yml` | Loaded Agent/Skill permission matrix |
| CR with explicit owners | `requirement`, `development`, `test` owners with `id` and `assigned-at` |
| Human approvers identified | Names for each of the four human approval gates |
| `.crctl/` directory | Auto-created by crctl for audit log, outbox, config, grants, and keys |

## Fork & Cross-Repo Customization Ledger

This is a fork of `xinyiai0724/tools` maintained at `OldBoy405/AI-First-tools` on branch `main`. crctl and the drift governance system are custom additions beyond upstream. `CUSTOM.md` is the **cross-repo customization ledger**: it records capabilities that depend on external platform (Multica / Pipeline Runner) coordination and are not yet end-to-end deliverable (e.g. reject-reason injection, signed-approval dispatch, owners/inbox outbox consumption, per-repo publish locks). Those `pending` items must not be described as delivered in Skill/Pipeline/README text.

## Key Bug Fixes (Post-V2)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| EVIDENCE_DRIFT false positive | Windows autocrlf checked out CRLF, causing byte-level hash mismatch | Line-ending normalization (`\r\n` → `\n`) before hashing in `evidenceSha16` and `canonicalEvidenceDigest` |
| RE2 regex incompatibility | Go gitguard uses RE2, which rejects `(?!...)` lookahead | Replaced with equivalent character class `^[^-].*$` |
| Bare `--grant` crash | `path.isAbsolute(true)` threw `ERR_INVALID_ARG_TYPE` when no argument provided | Defaults to `.crctl/grants/{cr}-{stage}.grant.json` |
| Idempotency key collision | Embedded mode used empty string for `commit_sha`, causing `cr_sync_event` ON CONFLICT silent drops | `pendingCommitSha()` generates process-unique `pending:{ts}:{pid}:{seq}` placeholders |
| Windows outbox crash | Outbox filenames contained colons (illegal on Windows) | Filename fragment sanitization; event content unchanged |

## Source References

| Concept | Primary Source |
|---------|---------------|
| Drift governance v2 | `docs/漂移治理_v2.md` |
| Drift governance v1 | `docs/漂移治理.md` |
| crctl Skill | `skills/shared/crctl/SKILL.md` |
| crctl implementation | `skills/shared/crctl/scripts/crctl.mjs` |
| crctl transaction layer | `skills/shared/crctl/scripts/lib/durable-tx.mjs`, `lib/workspace-transactions.mjs`, `lib/yaml-subset.mjs` |
| crctl gates | `skills/shared/crctl/gates.json` |
| crctl test suite | `skills/shared/crctl/scripts/test/crctl.test.mjs` |
| Controlled shell rules | `skills/shared/controlled-shell/rules.json` |
| Controlled shell commentary | `skills/shared/controlled-shell/SKILL.md` |
| Claude Code adapter | `skills/shared/crctl/adapters/claude-code/` |
| CI guard template | `skills/shared/crctl/adapters/ci/cr-guard.template.yml` |
| Matrix checker | `skills/shared/crctl/scripts/check-skill-matrix.mjs` |
| Contract checker | `skills/shared/crctl/scripts/check-agents-contract.mjs` |
| Prompt-drift lint | `skills/shared/crctl/scripts/lint-prompts.mjs` |
| Cross-repo customization ledger | `CUSTOM.md` |
