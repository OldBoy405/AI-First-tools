---
type: Architecture
title: Pipeline Templates & Workflows
description: The 8 pipeline templates that orchestrate the full R&D lifecycle — JSON structure, node types, review loops, human approval gates, and how pipelines connect skills and agents.
tags: [pipelines, workflows, orchestration, review-loop, templates]
---

# Pipeline Templates & Workflows

Pipeline templates are JSON definitions that orchestrate multi-step R&D workflows. Each template declares nodes (Skill invocations or human approvals), inputs, and review loops. The 8 active pipelines cover the full lifecycle from product planning through code implementation and writeback.

## Pipeline JSON Structure

Every pipeline follows the `PipelineDefinition` schema:

```json
{
  "id": "unique-id",
  "name": "Human-readable name",
  "description": "...",
  "triggerCommand": "/planning",
  "scope": "product-planning | product-design | product-dev",
  "isDefault": false,
  "inputs": [
    { "key": "topic", "label": "...", "type": "text", "required": true }
  ],
  "nodes": [
    {
      "id": "uuid",
      "kind": "skill | human_approval | code_generation",
      "label": "...",
      "ref": "skill-name",
      "prompt": "Detailed instructions with {{inputs.key}} interpolation",
      "onFail": "abort | skip",
      "timeoutMinutes": 60,
      "reviewLoop": {
        "maxAttempts": 3,
        "passCondition": { "allOf": ["verdict==pass", "blockers==[]"] },
        "repairNodeId": "...",
        "replayNodes": ["...", "..."]
      }
    }
  ]
}
```

### Node Kinds

| Kind | Purpose | Example |
|------|---------|---------|
| `skill` | Invokes a registered Skill from `skills/_index.yml` | `write-requirement-prd`, `review-code` |
| `human_approval` | Blocks until a human confirms via the TODO system | `human_approval` before `approve-requirement` |
| `code_generation` | Invokes an external coding runtime (Claude Code, Codex, Cursor) | `implement-code` node |

### Review Loops

Nodes that perform automated review can declare a `reviewLoop`:

- **`maxAttempts`**: Maximum self-repair cycles (default 3)
- **`passCondition`**: Machine-readable conditions using `allOf` / `anyOf` with expressions like `verdict==pass`, `blockers==[]`, `approved==true`
- **`repairNodeId`**: The node to jump back to when blockers are found
- **`replayNodes[]`**: When repair requires rerunning multiple nodes (e.g., code fix → test report → checkpoint → re-review)

## The 8 Active Pipelines

### Main Workflow (Sequential)

```mermaid
flowchart LR
    A["/planning<br/>optional"] --> B["/requirement"]
    B --> C["/architecture"]
    C --> D["/coding"]
    D --> E["/writeback"]
    E --> F["archived"]
    G["/resume"] -.-> B
    G -.-> C
    G -.-> D
```

| # | Trigger | Pipeline | Nodes | Owner | Phase |
|---|---------|----------|-------|-------|-------|
| 0 | `/planning` | `product-planning` | 8 | product-planning-agent | Planning |
| 0a | `/insight-brief` | `market-to-plan` | 5 | product-planning-agent | Planning |
| 0b | `/comp-radar` | `competitive-radar` | 5 | competitive-analyst-agent | Planning |
| 1 | `/requirement` | `requirement-authoring` | 6 | requirement-writer | Requirement |
| 2 | `/architecture` | `architecture-design` | 5 | dev-agent | Design |
| 3 | `/coding` | `code-implementation` | 12 | dev-agent | Coding |
| 4 | `/writeback` | `feature-writeback` | 5 | system-orchestrator | Writeback |
| R | `/resume` | `resume-cr` | 3 | system-orchestrator | Recovery |

### Planning Pipelines (Optional)

The three planning pipelines are optional and do not create CRs:

- **`/planning`**: User feedback analysis → market research → competitive analysis → current product analysis → planning report → AI review → human approval → roadmap
- **`/insight-brief`**: Raw insight extraction → insight brief → planning suggestion draft → human approval → write to planning KB
- **`/comp-radar`**: Fetch competitor updates → competitive report → convert to planning suggestions → human approval → write to planning KB

### Main Delivery Pipeline (Required)

The four required pipelines form the main delivery chain:

**`/requirement`** — CR registration with worktree creation, PRD writing, requirement review (with auto-repair loop), human approval, `approve-requirement` state advance. Prerequisite: none. Output: `prd.md`, status=`requirement-approved`.

**`/architecture`** — SDD writing based on approved PRD, tech design review (with auto-repair loop), human approval, `approve-tech-design` state advance, checkpoint push. Prerequisite: status=`requirement-approved`. Output: `sdd.md`, status=`tech-design-reviewed`.

**`/coding`** — Development plan → task breakdown → human approval to start → code implementation (via external coding runtime) → test report generation (with auto-fix loop) → code checkpoint → code review (with auto-fix loop) → human approval → `approve-code` state advance. Prerequisite: status=`tech-design-reviewed`. Output: code, `test-report.md`, status=`code-approved`.

```mermaid
flowchart TD
    D1["write-dev-plan"] --> D2["write-dev-tasks"]
    D2 --> D3["push-progress (checkpoint)"]
    D3 --> D4["human_approval (dev start)"]
    D4 --> D5["approve-dev-start"]
    D5 --> D6["implement-code"]
    D6 --> D7["write-test-report"]
    D7 --> D7G{"test pass?"}
    D7G -- "no: blocks" --> D6
    D7G -- "yes" --> D8["push-progress (code checkpoint)"]
    D8 --> D9["review-code"]
    D9 --> D9G{"review pass?"}
    D9G -- "no: blocks" --> D6
    D9G -- "yes" --> D10["human_approval (code)"]
    D10 --> D11["approve-code"]
    D11 --> D12["push-progress (final)"]
```

**`/writeback`** — Merge CR branches to trunk → writeback PRD/SDD to `specs/` → writeback TASKs to `delivery/task/` → generate traceability chain → archive CR (move to `_history.yml`, clean up worktrees). Prerequisite: status=`code-approved`. Output: `specs/{id}/`, `delivery/task/`, `traceability.yml`, status=`archived`.

**`/resume`** — For recovering in-flight CRs when switching machines or collaborators: verify remote checkpoints → restore worktrees → show CR status and next step.

## Human Approval Pattern

Human approval nodes do not directly change state. They block until a human confirms, then the following Skill node writes evidence and advances state:

| Human Approval Node | Follow-Up Skill | Target State |
|---------------------|-----------------|--------------|
| Requirement approval | `approve-requirement` | `requirement-approved` |
| Architecture approval | `approve-tech-design` | `tech-design-reviewed` |
| Development start | `approve-dev-start` | `developing` |
| Code approval | `approve-code` | `code-approved` |

In standalone IDE usage, [crctl approve](/openwiki/operations/drift-governance.md#crctl-subcommands) provides an interactive terminal replacement for human approval.

## Pipeline Contracts

When modifying pipelines, observe these rules from `dir-graph.yaml#pipeline_templates.contract`:

1. `human_approval` nodes must be followed by explicit `approve-*` or write-type Skills
2. `code-implementation` must generate `test-report.md` before `review-code`
3. Auto-review nodes must declare `reviewLoop`; blockers must route back to `repairNodeId`
4. If repair requires multiple replays, declare `replayNodes[]`
5. Auto-review nodes must persist `review-loop.current-attempt` and `review-loop.attempts[]`
6. CR-class loops must sync to `traceability.yml`
7. `feature-writeback` must require `spec_id` and `target_version` — empty values are not allowed

## Source References

| Concept | Primary Source |
|---------|---------------|
| Pipeline JSON schema | `pipeline-templates/*.pipeline.json` |
| Pipeline registry | `pipeline-templates/_index.yml` |
| Pipeline contracts | `dir-graph.yaml#pipeline_templates.contract` |
| Pipeline editing rules | `AGENTS.md` §修改 Pipeline |
| Self-check command | `AGENTS.md` §自检命令 |
