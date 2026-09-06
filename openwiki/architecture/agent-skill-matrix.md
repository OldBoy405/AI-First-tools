---
type: Architecture
title: Agent/Skill Permission Matrix
description: The Agent/Skill permission and ownership system — owns, can-call, external, forbidden relations — plus pipeline owners, actor summary, and the quality-reviewer ownership split.
tags: [agents, skills, permissions, matrix, ownership]
openwiki:
  roles: [architecture, domain]
  change_kinds: [public-api, ownership]
  source_paths:
    - agent-skill-matrix.yml
    - agents/_index.yml
    - skills/_index.yml
  symbols: [owns, can-call, external, forbidden, pipeline-owners, actors]
  test_paths:
    - skills/shared/crctl/scripts/check-skill-matrix.test.mjs
    - skills/shared/crctl/scripts/check-agents-contract.test.mjs
  invariants:
    - Every active skill has exactly one owns owner.
    - Review skills are owned by quality-reviewer-agent, not by the writing/approval agents.
    - feature-writeback is owned by delivery-agent.
  validation_commands:
    - node skills/shared/crctl/scripts/check-skill-matrix.mjs
    - node skills/shared/crctl/scripts/check-agents-contract.mjs
---

# Agent/Skill Permission Matrix

The Agent/Skill relationship is governed by `agent-skill-matrix.yml` — the machine-readable source of truth for which Agent owns, may call, or is forbidden from invoking each Skill. This page explains the permission model, the actor landscape, and the pipeline ownership structure.

## Relation Types

| Relation | Meaning | Constraint |
|----------|---------|------------|
| `owns` | Actor is the primary maintainer and default executor of this Skill | Every active Skill must have exactly one `owns` owner |
| `can-call` | Actor may invoke this Skill within its responsibility boundary | Does not imply ownership; must still respect Skill preconditions |
| `external` | Skill provided by the target runtime (e.g., `brainstorming`, `executing-plans`) | Phase0 tools does not bundle a `SKILL.md` for it |
| `forbidden` | Actor is explicitly prohibited from calling this Skill | Prevents cross-domain violations and process bypass |

The permission matrix is consumed by the platform orchestrator and by [`crctl`](/openwiki/operations/drift-governance.md) for drift governance checks. Note that `forbidden` is a **declarative boundary**: enforcement relies on agent self-discipline plus protectedPaths file guards (write-protection of critical ledgers/artifacts) — there is **no call-level runtime interception**, and this package does not add runtime hooks for it. Likewise, `can-call: crctl` is a Skill-level relation; the *subcommand* scope is constrained by the Agent prompt, the corresponding Skill, and the runtime caller policy — the v1 matrix checker does not parse subcommand lists as separate permission fields.

## Actors

### Primary Agents (Interactive, User-Facing)

| Agent | Scope | Owns These Skills |
|-------|-------|-------------------|
| **product-planning-agent** | Product planning & market research | `analyze-user-feedback`, `conduct-market-research`, `analyze-current-product`, `write-planning-report`, `review-planning-report`, `write-roadmap`, `write-planning-entry`, `extract-market-insight`, `gather-product-context`, `planning-draft`, `record-idea`, `focus-briefing` |
| **requirement-writer** | CR registration & PRD | `requirement-register`, `write-requirement-prd`, `approve-requirement` |
| **dev-agent** | Design through code approval | `write-tech-design`, `approve-tech-design`, `write-dev-plan`, `write-dev-tasks`, `approve-dev-start`, `implement-code`, `write-test-report`, `approve-code`, `coding-discipline` |
| **competitive-analyst-agent** | Competitive intelligence | `fetch-competitor-updates`, `write-competitive-report`, `report-to-planning-suggestion` |
| **customer-support-agent** | Product Q&A | (none owned — primarily reads specs) |

### Sub-Agents (Pipeline-Internal)

| Agent | Scope | Owns These Skills |
|-------|-------|-------------------|
| **spec-agent** | Baseline spec queries | `spec-show`, `spec-query`, `spec-dashboard` |
| **delivery-agent** | Merge, writeback & archive | `merge-feature-branch`, `writeback-prd-sdd`, `writeback-tasks`, `writeback-traceability`, `cr-archive` |
| **quality-reviewer-agent** | All review gates | `review-alignment`, `review-requirement`, `review-tech-design`, `review-dev-plan`, `review-code` |
| **knowledge-agent** | Cross-feature documentation | (thin — `can-call` `engineering-docs`, `validate-doc`, `record-idea`) |

### System Actors

The matrix declares two **system** actors in addition to the 9 deployable agents:

| Actor | Role | Notes |
|-------|------|-------|
| **cr-coordinator-agent** | leader | Coordinates and delegates; `can-call` `cr-dashboard`, `cr-query`, `cr-show`, `crctl`; forbidden from all business write/review/approve skills (a coordination boundary, not a pipeline owner) |
| **system-orchestrator** | infra | Owns `push-progress`, `pull-progress`, `workspace-freshness`, `resume-from-remote`, `list-remote-checkpoints`, `handover-cr`, `validate-doc`, `engineering-docs`, `controlled-shell`, `crctl`, `cr-review-record`, `inbox-emit`, `cr-inbox`, `cr-query`, `cr-show`, `cr-dashboard` |

The **review-skill ownership moved to `quality-reviewer-agent` in CR-2026-053**: `review-requirement` left `requirement-writer`, and `review-tech-design`/`review-dev-plan`/`review-code` left `dev-agent`. The writing/approval agents now `can-call` their corresponding review skill but no longer own it, keeping write/review/approve roles separated.

## Pipeline Owners

Each pipeline has exactly one owner, declared in `agent-skill-matrix.yml#pipeline-owners`:

| Pipeline | Owner |
|----------|-------|
| `product-planning` | product-planning-agent |
| `market-to-plan` | product-planning-agent |
| `competitive-radar` | competitive-analyst-agent |
| `requirement-authoring` | requirement-writer |
| `architecture-design` | dev-agent |
| `code-implementation` | dev-agent |
| `feature-writeback` | delivery-agent |
| `resume-cr` | system-orchestrator |

`feature-writeback` was promoted from `system-orchestrator` to `delivery-agent` (CR-2026-056) once delivery-agent absorbed the merge/writeback/archive skill set.

## Forbidden Boundaries

Several cross-domain boundaries are explicitly forbidden to prevent process bypass:

- **product-planning-agent** is forbidden from `requirement-register`, `implement-code`, `merge-feature-branch`, `cr-archive`
- **requirement-writer** is forbidden from `writeback-prd-sdd`, `implement-code`, `merge-feature-branch`, `cr-archive`
- **dev-agent** is forbidden from `writeback-prd-sdd`, `merge-feature-branch`, `cr-archive`
- **spec-agent** is forbidden from `requirement-register`, `implement-code`, `writeback-prd-sdd`, `writeback-traceability`
- **delivery-agent** is forbidden from `write-requirement-prd`, `write-tech-design`, `implement-code` (writeback/merge actors do not author product or code artifacts)
- **quality-reviewer-agent** is forbidden from all `approve-*` skills and from `merge-feature-branch`, `writeback-*`, `cr-archive`, `checkpoint`, `write-test-report`, `coding-discipline` (reviewers cannot advance or write back)

## Editor Conventions

When modifying the matrix:

1. New active Skills must be assigned exactly one `owns` owner in `agent-skill-matrix.yml`
2. Agent definition files must reference only Skills that appear in their `owns` or `can-call`
3. Pipeline `node.ref` values must point to Skills with existing owners
4. External methodology Skills (provided by target runtimes) must only appear in `external`; phase0's own rules (e.g. `coding-discipline`) serve as the fallback source of truth — installed externals act as optional accelerators, never hard dependencies
5. `forbidden` expresses active prohibition — not "not yet supported"

## Contract Invariants & Automated Enforcement

The matrix is protected by a [CI guard system](/openwiki/operations/ci-guards.md) that runs three zero-dependency Node.js scripts on every commit and push:

- **`check-skill-matrix.mjs`**: Verifies every active skill has exactly one `owns` owner, every owned skill is registered (or external), the human-readable `AGENT-SKILL-MATRIX.md` table matches the machine-readable `agent-skill-matrix.yml`, and every actor-level `external` declaration has at least one reference point in `skills/` or `pipeline-templates/` (CR-2026-025 FR-1).

- **`check-agents-contract.mjs`**: Verifies the four [agent contract invariants](/openwiki/architecture/overview.md#agent-contract-invariants) — bidirectional agent registration, valid skill references, matrix coverage of referenced skills, and the behavioral constraint against bypassing skills for controlled writes.

- **`lint-prompts.mjs`**: Blocks prompt text that would reintroduce manual ledger writes or stale `crctl` invocations (see [CI guards](/openwiki/operations/ci-guards.md)).

These checks run in `.githooks/pre-commit` (local) and `.github/workflows/crctl-ci.yml` (CI on push/PR for changes to `skills/**`, `pipeline-templates/**`, `dir-graph.yaml`, `agent-skill-matrix.yml`, `agents/**`, `AGENTS.md`, `AGENT-SKILL-MATRIX.md`, `README.md`, `ARCHITECTURE.md`, and `rules.json`). Matrix drift is caught before it reaches the main branch.

## Source References

| Concept | Primary Source |
|---------|---------------|
| Permission matrix (machine) | `agent-skill-matrix.yml` |
| Permission matrix (human) | `AGENT-SKILL-MATRIX.md` |
| Agent registry | `agents/_index.yml` |
| Skill registry | `skills/_index.yml` |
| Agent contract invariants | `dir-graph.yaml#agents.contract` |
| Matrix consistency checker | `skills/shared/crctl/scripts/check-skill-matrix.mjs` |
| Agent contract checker | `skills/shared/crctl/scripts/check-agents-contract.mjs` |
| Prompt-drift lint | `skills/shared/crctl/scripts/lint-prompts.mjs` |
| CI enforcement | `.github/workflows/crctl-ci.yml` |
| Matrix maintenance rules | `AGENTS.md` §编辑规则, `AGENT-SKILL-MATRIX.md` §维护规则 |
