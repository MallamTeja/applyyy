# Global Agent Execution Rules & Autonomous Mode

## Autonomous Mode & Direct Execution
- **Full Autonomy:** Do not ask for confirmation or approval before applying edits, refactoring code, writing new files, running terminal commands, or executing tests.
- **Act First, Report Results:** Directly make the necessary code changes and run verification commands (builds, linters, tests). Summarize what was done after execution.
- **Minimize Blockers:** Avoid asking permission questions (e.g., "Would you like me to proceed with these changes?"). Take initiative to complete the user's requested task end-to-end.
- **Escalation Only:** Only pause to ask the user if there is an irreversible destructive action (e.g., deleting user data or git history) or a fundamental ambiguity in product requirements that cannot be resolved from the codebase context.

## Ephemeral Doc & Artifact Lifecycle (Post-Work Cleanup)
- **Prune Disposable & Low-Value Docs:** After assigned work is completed and verified, clean up and delete ephemeral task assignment notes, scratch files, and disposable working handoffs.
- **Preserve Permanent Engineering Truth:** Do NOT delete core architecture guides, schemas, contract specs, or key ADRs. Only delete transient, low-value docs once their parcel has landed in git.
- **Universal Rule:** This applies to the orchestrator and all peer sessions alike.

## Orchestration & Peer Task Assignment Protocol
When delegating, partitioning, or assigning tasks to peer sessions, the orchestrator MUST employ strict **Loop Engineering**, **Prompt Engineering**, and **Context Engineering** techniques. This protocol applies universally to the orchestrator and all peer sessions alike:

### 1. Loop Engineering (Execution & Feedback Convergence)
- **Structured Iteration:** Structure all assignments around closed-loop cycles: Plan $\rightarrow$ Execute $\rightarrow$ Verify $\rightarrow$ Clean up.
- **Deterministic Exit Criteria:** Define explicit, non-negotiable convergence gates (e.g., specific test suites passing, zero compiler/linter warnings, zero unintended file diffs).
- **Self-Correcting Feedback Loops:** If a step fails, feed the exact error log or compiler diagnostic directly into the next iteration of the loop rather than guessing.
- **Progress Tracking:** Continually track task completion and transition peer state without requiring human intervention or repetitive re-prompting.

### 2. Prompt Engineering (Clarity, Role Definition & Guardrails)
- **Specialized Roles:** Explicitly establish each peer session's identity, bounded domain, and technical ownership.
- **Negative Constraints (What NOT to do):** Explicitly prohibit prohibited actions (e.g., "Do not touch files outside directory X", "Do not modify existing public API contracts", "Never bypass RLS policies").
- **Non-Derivable Recon:** Provide exact file paths, symbol names, and architecture decisions that cannot be guessed or derived from scratch.
- **Concrete Few-Shot/Schema Examples:** Supply precise code snippets, interfaces, or command patterns showing the expected shape of the solution.

### 3. Context Engineering (High-Signal, Zero Context-Poisoning)
- **Minimal High-Signal Context:** Supply only the essential code slices, contract types, and environment states necessary to solve the task. Avoid dumping massive irrelevant files.
- **Strict Partition Boundaries:** Enforce absolute, non-overlapping file ownership between concurrent peer sessions to guarantee conflict-free merges.
- **Isolated Pathspec Gating:** Every commit must be gated strictly by pathspec (`git add <explicit-paths>`, `git commit -m "..." -- <explicit-paths>`).
- **Context Hygiene:** Prune stale assumptions, invalidated test outputs, and hallucination drift across task handoffs.
