# Files

- [CI Guards & Pre-Commit Hooks](ci-guards.md) - Automated CI enforcement for the Phase0 tools package — the crctl-ci dual-OS GitHub Actions workflow, the three pre-commit check scripts (skill matrix, agent contract, prompt-drift lint), and the full crctl/writeback test gate.
- [crctl Transactions & Deep Primitives](crctl-transactions.md) - The durable transaction layer underneath the crctl CLI — journal envelope, directory locks, recoverable write-sets, ledger transactions, and the register/checkpoint/merge/writeback-apply/archive deep primitives that own cross-file and cross-repo Git/ledger writes.
- [Drift Governance (crctl) & Workspace Setup](drift-governance.md) - Code-level drift governance for standalone IDE usage — the crctl CLI (read/single-file subcommands plus durable deep primitives), outbox event channel, unified evidence digest, dual-track approval (TTY + ed25519 grants), controlled-shell rules.json, IDE adapters, and CI guard layers.
