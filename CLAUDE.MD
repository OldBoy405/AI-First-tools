# CLAUDE.MD

This phase0 tools package uses `AGENTS.md` as the single authoritative instruction file.

Claude agents must read files in this order before acting:

1. `AGENTS.md`
2. `dir-graph.yaml`
3. `README.md`
4. The task-specific files identified from the user request and directory graph

Do not duplicate or override the rules from `AGENTS.md` here. If behavior needs to change, update `AGENTS.md` so all AI tools share the same source of truth.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
