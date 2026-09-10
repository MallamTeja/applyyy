# `applyy` docs index

One file per topic. Where a stream needs a written contract it lives **inside
that stream's own tree** and is linked from here rather than copied — duplicated
facts drift and then contradict each other.

| Doc | Topic |
|-----|-------|
| [architecture/agents.md](architecture/agents.md) | **The agent roster, in detail.** All twelve agent identities, what each does and why, which status transitions each may make, which cost Gemini calls, and — marked per agent — which actually exist versus which are only designed. Includes the kill switch and what it stops |
| [PROGRESS.md](PROGRESS.md) | **Live status.** Per-stream state with evidence, decisions and their reasoning, what is waiting on Teja, and what is explicitly not done |
| [verification-traps.md](verification-traps.md) | **Read before testing a guard or believing a green.** Fourteen instances of a check that reported success for a reason other than the one you believed, and the rule that a test passing without its guard is testing the composite |
| [audit/2026-09-10-handoff-verification.md](audit/2026-09-10-handoff-verification.md) | **Read before trusting the handoff.** Three claims from `applyyy-9f`'s transfer checked against the artifact and found false — including its stated top priority — plus one defect it never saw: the Vercel project has zero env vars |
| [line-endings-determinism.md](line-endings-determinism.md) | Why CRLF is a correctness bug here and not a style one — it breaks the byte-for-byte approval guarantee and `tailored_hash`; the measured evidence and the `.gitattributes` rule |
| [audit/2026-09-10-schema-invariants-verified.md](audit/2026-09-10-schema-invariants-verified.md) | First execution of the 7 migrations: the one failure, the fix, and the three product invariants proven against a live Postgres — plus what it explicitly does not prove |
| [decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md](decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md) | **Read before reopening the mail question.** Continuous Gmail read AND write are already safe and available — only automated *sending* is the risk. Why Zoho loses to "no credential at all", and a premise defect in §12 |
| [setup/gmail-tracker-apps-script.md](setup/gmail-tracker-apps-script.md) | Email tracking setup — why the Gmail API is the wrong tool, and the Apps Script path that replaces it |
| [`../packages/shared-types/SCHEMA_CONTRACT.md`](../packages/shared-types/SCHEMA_CONTRACT.md) | *(owned by `applyyy-aa`)* Authoritative column-level database contract |
| [tooling/cli-auth-windows.md](tooling/cli-auth-windows.md) | Vercel + Supabase CLI install state and permanent-login setup on this Windows machine |
| [tooling/mcp-vs-cli-vercel-supabase.md](tooling/mcp-vs-cli-vercel-supabase.md) | Capability comparison: MCP servers vs CLIs for Vercel and Supabase, and how to choose |
| [audit/2026-09-09-locked-logic-coverage.md](audit/2026-09-09-locked-logic-coverage.md) | Verification that §18's locked logic is captured in the plan — found prose-only, no column-level spec; secondary plan-drift findings |
