---
type: Architecture
title: Agent/Skill Permission Matrix
description: The Agent/Skill permission and ownership system — owns, can-call, external, forbidden relations — plus pipeline owners, actor summary, and known design gaps.
tags: [agents, skills, permissions, matrix, ownership]
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

The permission matrix is consumed by the platform orchestrator and by [`crctl`](/openwiki/operations/drift-governance.md) for drift governance checks. Note that `forbidden` is a **declarative boundary**: enforcement relies on agent self-discipline plus protectedPaths file guards (write-protection of critical ledgers/artifacts) — there is **no call-level runtime interception**, and this package does not add runtime hooks for it.

## Actors

### Primary Agents (Interactive, User-Facing)

| Agent | Scope | Owns These Skills |
|-------|-------|-------------------|
| **product-planning-agent** | Product planning & market research | `analyze-user-feedback`, `conduct-market-research`, `analyze-current-product`, `write-planning-report`, `review-planning-report`, `write-roadmap`, `write-planning-entry`, `extract-market-insight`, `gather-product-context`, `planning-draft`, `record-idea`, `focus-briefing` |
| **requirement-writer** | CR registration & PRD | `requirement-register`, `write-requirement-prd`, `review-requirement`, `approve-requirement` |
| **dev-agent** | Design through code approval | `write-tech-design`, `review-tech-design`, `approve-tech-design`, `write-dev-plan`, `write-dev-tasks`, `approve-dev-start`, `implement-code`, `write-test-report`, `review-code`, `approve-code`, `coding-discipline` |
| **competitive-analyst-agent** | Competitive intelligence | `fetch-competitor-updates`, `write-competitive-report`, `report-to-planning-suggestion` |
| **customer-support-agent** | Product Q&A | (none owned — primarily reads specs) |

### Sub-Agents (Pipeline-Internal)

| Agent | Scope | Owns These Skills |
|-------|-------|-------------------|
| **spec-agent** | Baseline spec queries | `spec-show`, `spec-query`, `spec-dashboard` |
| **delivery-agent** | Task writeback | `writeback-tasks` |
| **quality-reviewer-agent** | Cross-cutting quality gates | `review-alignment`, `change-impact-analysis` |
| **knowledge-agent** | Cross-feature documentation | (thin — reuses shared skills) |

### System Orchestrator

The **system-orchestrator** is not a deployable agent but a runtime component that owns cross-cutting infrastructure skills: `merge-feature-branch`, `writeback-prd-sdd`, `writeback-traceability`, `push-progress`, `pull-progress`, `resume-from-remote`, `list-remote-checkpoints`, `handover-cr`, `validate-doc`, `engineering-docs`, `controlled-shell`, `crctl`, `cr-review-record`, `cr-status-set`, `inbox-emit`, `cr-archive`, `feedback-writeback`, `cr-inbox`, `cr-query`, `cr-show`, `cr-dashboard`.

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
| `feature-writeback` | system-orchestrator |
| `resume-cr` | system-orchestrator |

## Forbidden Boundaries

Several cross-domain boundaries are explicitly forbidden to prevent process bypass:

- **product-planning-agent** is forbidden from `requirement-register`, `implement-code`, `merge-feature-branch`, `cr-status-set`, `cr-archive`
- **requirement-writer** is forbidden from `writeback-prd-sdd`, `implement-code`, `merge-feature-branch`, `cr-status-set`, `cr-archive`
- **dev-agent** is forbidden from `requirement-register`, `write-requirement-prd`, `approve-requirement`, `writeback-prd-sdd`, `cr-status-set`, `cr-archive`
- **spec-agent** is forbidden from `writeback-prd-sdd`, `writeback-tasks`, `writeback-traceability`

## Editor Conventions

When modifying the matrix:

1. New active Skills must be assigned exactly one `owns` owner in `agent-skill-matrix.yml`
2. Agent definition files must reference only Skills that appear in their `owns` or `can-call`
3. Pipeline `node.ref` values must point to Skills with existing owners
4. External methodology Skills (provided by target runtimes) must only appear in `external`; phase0's own rules (e.g. `coding-discipline`) serve as the fallback source of truth — installed externals act as optional accelerators, never hard dependencies
5. `forbidden` expresses active prohibition — not "not yet supported"

## Contract Invariants & Automated Enforcement

The matrix is protected by a [CI guard system](/openwiki/operations/ci-guards.md) that runs two zero-dependency Node.js scripts on every commit and push:

- **`check-skill-matrix.mjs`**: Verifies every active skill has exactly one `owns` owner, every owned skill is registered (or external), and the human-readable `AGENT-SKILL-MATRIX.md` table matches the machine-readable `agent-skill-matrix.yml`.

- **`check-agents-contract.mjs`**: Verifies the four [agent contract invariants](/openwiki/architecture/overview.md#agent-contract-invariants) — bidirectional agent registration, valid skill references, matrix coverage of referenced skills, and the behavioral constraint against bypassing skills for controlled writes.

These checks run in `.githooks/pre-commit` (local) and `.github/workflows/check-skill-matrix.yml` (CI on push/PR for changes to `skills/_index.yml`, `agent-skill-matrix.yml`, `AGENT-SKILL-MATRIX.md`, or `agents/**`). Matrix drift is caught before it reaches the main branch.

## Known Design Gaps

| Gap | Current State | Suggested Fix |
|-----|--------------|---------------|
| No independent writeback agent | `feature-writeback` is orchestrated by `system-orchestrator`; `spec-agent` only does post-writeback read verification | Add `writeback-agent` if a human entry point is needed |

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
| CI enforcement | `.github/workflows/check-skill-matrix.yml` |
| Matrix maintenance rules | `AGENTS.md` §编辑规则, `AGENT-SKILL-MATRIX.md` §维护规则 |
