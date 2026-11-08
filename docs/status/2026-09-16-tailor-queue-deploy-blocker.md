# Tailor & Queue "no acting agent" — a deploy blocker, not a code bug

> **Status 2026-11-08:** Superseded. The browser fast path it diagnoses (`handleFastTailor` on the Discovered page) was deleted on 2026-09-17 (`75a75a0`, "delete the audit_clean fast path"). Web status moves now go through the `advance_application_status` RPC (for example `apps/web/src/features/discovery/rejectJob.ts:99`). Current state: `docs/SYSTEM_ARCHITECTURE.md`. The body below is the original record, unedited.

**Date:** 2026-09-16
**Reported symptom:** clicking **⚡ Tailor & Queue** on <https://applyyy.vercel.app/discovered> fails with
`Failed to queue: status change discovered -> awaiting_approval refused: no acting agent. Use advance_application_status(), or set applyy.acting_agent for a manual fix.`
**Verdict:** the application code was fixed on 2026-09-12. It has never reached production, because the same commit that fixed it also broke the build.

---

## 1. The one-line story

`ab05ba4` fixed the bug and broke the typecheck **in the same commit**, so Vercel has been unable to ship since, and production is still serving the bundle that contains the bug.

---

## 2. Timeline (the whole diagnosis is in these four rows)

| When (IST) | Event |
| --- | --- |
| 2026-09-12 12:01 | `b049b8b` adds the Discovered Jobs page. `handleFastTailor` does a bare `.update({ status: 'awaiting_approval' })` straight from the browser. |
| 2026-09-12 **12:12** | **Last successful production deploy** (`applyyy-l39ijwgwi`). This bundle is what `applyyy.vercel.app` still serves. |
| 2026-09-12 12:24 | `ab05ba4` replaces the bare update with the six-step `advance_application_status()` RPC ladder — **the fix** — and, in the same diff, introduces three TypeScript errors in `apps/web/src/features/approval/ApprovalQueuePage.tsx`. |
| 09-12 → 09-16 | Every production and preview deploy reports `● Error`. Nothing has shipped for four days. |

The green deploy was cut **11 minutes after the bug landed and 12 minutes before it was fixed**. That is the entire coincidence this incident rests on.

---

## 3. Why Postgres refused the write (the guard is correct — do not change it)

`applyy_internal.guard_status_transition()` — [`supabase/migrations/20260909234900_status_transition_guard.sql`](../../supabase/migrations/20260909234900_status_transition_guard.sql), `BEFORE UPDATE ON public.applications` — rejects a status change in three distinct ways:

| Condition | SQLSTATE | Message |
| --- | --- | --- |
| No `applyy.acting_agent` set | `42501` | `status change X -> Y refused: no acting agent…` |
| No matching row in `application_status_transitions` | `23514` | `illegal status transition X -> Y… No such edge` |
| Edge exists, agent not in `allowed_agents` | `42501` | `agent Z may not perform X -> Y…` |

The reported error is the **first** branch, which fires before the edge lookup. That is diagnostic: it proves the caller issued a **raw PostgREST table update**, not a failed RPC. A failed RPC would have produced the `23514` message instead.

The acting agent travels in a transaction-local GUC rather than a column because it describes *who is writing*, not the row. `advance_application_status()` sets it via `set_config('applyy.acting_agent', p_agent::text, true)` — the `true` scopes it to the transaction, which matters because PgBouncer pools connections. A browser `.update()` never sets it, which is exactly the anonymous status write the guard exists to refuse.

**`discovered → awaiting_approval` is not a legal edge for any agent, and must not be added.** It would skip dedupe, filters, scoring, tailoring, and the auditor — including the human-only gate that Constraint 15 rests on. The legal route is six hops:

```
discovered → deduped          (normalizer)
           → passed_filters   (screener)
           → scored           (matcher)
           → tailored         (tailor)
           → audit_clean      (auditor)
           → awaiting_approval (auditor)
```

`DiscoveredJobsPage.tsx` already walks exactly this ladder with exactly these agents. Verified against the seeded transition table.

---

## 4. The actual blocker

`apps/web` builds with `tsc --noEmit && vite build`, so any type error anywhere in the package fails the entire deployment. The errors are in an unrelated feature (the approval queue), all introduced by `ab05ba4`:

```
ApprovalQueuePage.tsx(40,1)  TS6133  'ClaimDecision' is declared but its value is never read
ApprovalQueuePage.tsx(40,15) TS2459  'DiffView' declares 'ClaimDecision' locally, but it is not exported
ApprovalQueuePage.tsx(49,9)  TS6133  'toast' is declared but its value is never read
ApprovalQueuePage.tsx(78,15) TS2322  Property 'links' is missing in type … MasterProfile
```

Precision on the `TS2322`, because it is the only one that is not litter: `links` is required **twice** — on `MasterIdentity` (`profile-nodes.ts:143`) and again at the top level of `MasterProfile` (`:353`). The fallback literal satisfies the inner one and misses the outer. The type's own comment at `:342-350` states these are *"REQUIRED ARRAYS, POSSIBLY EMPTY … never optional"*, precisely so the compiler names every construction site not yet updated. This fallback is one of those sites, so `links: []` is the honest value rather than a compiler-silencer.

`vite build` itself is healthy — it exits 0 in 2.86s over 177 modules. The `&&` gate in front of it is the only thing stopping the deploy.

The `TS2459` was cleared in `92107bc` (already pushed) by adding `export type ClaimDecision` to `DiffView.tsx:47`. The remaining three are being cleared by the session holding the write grant on that file. When the count reaches zero and the push deploys green, the queue bug resolves with **no change to any migration and no change to the discovery feature**.

**A green local build is not a green deploy.** The deployment must be confirmed against `vercel ls` after the push, not inferred from a passing `tsc`.

---

## 5. Open items this fix does *not* address

1. **The ladder is six separate transactions.** A failure at hop 4 strands the row at `scored`. The graph has no backward edge to recover it, so the row needs a human with SQL access. The right shape is a single `queue_discovered_application()` RPC performing all six hops in one transaction.
2. **The ladder claims agent identities for work that never happened.** It asserts `matcher`, `tailor` and `auditor` in sequence, so the row arrives at `awaiting_approval` with no score, no tailored resume and no audit — while the audit trail records that all three ran. This is a correctness problem in the audit log, not just a shortcut.
3. **A migration comment is factually wrong.** [`20260909234700_core_tables.sql:471`](../../supabase/migrations/20260909234700_core_tables.sql) claims *"a bare UPDATE passes the guard but skips the claim release and strands the row."* A bare UPDATE does **not** pass the guard — it is refused with `42501`. Anyone debugging from this comment would hunt for a stranded row instead of a refused write. The migration is already applied, so correct it in a new migration's comment or in `SCHEMA_CONTRACT.md`, not by editing applied SQL.
4. **`docs/PROGRESS.md:564-575` asserts an invariant that was not true**: *"Every status write goes through `advance_application_status()`."* `b049b8b` shipped a status write that did not. It is a convention, not an enforced invariant — the only enforcement is the guard, which is why the guard caught it.
5. **Nothing alerts on a failed deploy.** Production stopped deploying on 09-12 and was noticed on 09-16, by a user hitting a bug that had already been fixed. A deploy-status notification, or a CI gate on `main`, would have caught this in minutes.

---

## 6. Naming note

The Supabase project is named **`applyy`** (two y's), the npm scope is `@applyy/*`, the GUC is `applyy.acting_agent`, and the repo folder and Vercel domain are **`applyyy`** (three). Per `packages/master-pdf/package.json`, two y's is the standard and only the repo folder is three. Worth stating once in `CLAUDE.md` so nobody "fixes" the GUC spelling and takes the guard down.

---

## 7. Evidence

- `vercel ls applyyy` — five consecutive `● Error` deployments, last `● Ready` at 2026-09-12 12:12:42.
- `vercel inspect <deployment> --logs` — build fails on the four `tsc` diagnostics above.
- `supabase migration list` — all 15 local migrations applied remotely; repo SQL == production SQL, so the guard behaves as written here.
- `git log` — `b049b8b` 12:01, `ab05ba4` 12:24, both 2026-09-12.
- `grep -rn "Failed to queue"` — no match anywhere in the working tree, confirming the failing string comes from a deployed bundle, not from current code.
