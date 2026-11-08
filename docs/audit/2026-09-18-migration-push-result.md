# The migration push — applied, measured before and after

> **Status 2026-11-08:** Historical. "18 of 18 applied" was true on 2026-09-18. As of 2026-11-08 the repo holds 60 migration files (`git ls-files supabase/migrations | wc -l`); never quote either number, re-measure with the Supabase MCP `list_migrations` against that listing. The `guard_status_insert` trigger and `bootstrap_user_defaults()` this push installed are described in `CLAUDE.md` section 7 and `docs/stack/2026-11-05-database.md`. The body below is the original record, unedited.

**Applied:** 2026-09-18, ~15:55 IST, session `applyyy-b2`, authorised by Teja directly.
**Result:** all three migrations applied, `PUSH_EXIT=0`, no partial state. The backlog is now
**zero pending, 18 of 18 applied.**

    supabase db push --linked

Baseline taken **before** the push, from the live database, read-only. That ordering is the whole
point: a count taken only afterwards cannot distinguish *"seeded 9"* from *"was already 9"* — and
the migration whose effect was most in doubt is exactly the one that needed the distinction.

---

## 1. What changed

| | before | after | verdict |
|---|---|---|---|
| migrations applied | 15 of 18 | **18 of 18** | backlog closed |
| `guard_status_insert` trigger | absent | **present** | `20260917130000` live |
| `bootstrap_user_defaults()` inserts | `evaluation_order` (a column that does not exist) | **`sort_order`** | `20260917124500` live |
| user `0f4b24da…` seeded rows | 9 / 1 / 1 | 9 / 1 / 1 | untouched, correctly |
| user `31e899ad…` seeded rows | **0 / 0 / 0** | **9 / 1 / 1** | **backfilled** |
| `application_events` correction rows | 0 | **3** | `20260917174600` live, first run |
| `application_events` total | 36 | 39 | +3, matching |

---

## 2. The migration reviewed as "LOW on effect" did the most

`20260917124500` was reviewed on 2026-09-17 as **"APPLY WITH CAVEAT. High on SQL, LOW on effect"**,
on the stated premise that there was no Supabase Auth user for its backfill to act on
(`docs/PROGRESS.md:70`, review §1.3). **That premise was false.** There are two users, and the
second held **zero** filter_rules, search_preferences and system_settings.

After the push it holds **9 / 1 / 1**. The backfill was the entire point and it was nearly
deferred forever on the strength of a count nobody had re-measured.

**Two claims in the review doc did not just mislead, they discouraged the check that refutes
them** — *"the break is not live yet"* and *"do not go looking for damage that may never have been
done."* Both were false. The deployed function really did contain `evaluation_order`. **An
instruction not to look is the most expensive kind of wrong:** a stale fact gets re-measured by the
next person who needs it; a stale fact that says measuring is pointless does not.

---

## 3. Two results that needed explaining, and one of them was my own error

### 3.1 The retraction wrote 3 rows, not 18 — and 3 is correct

18 `application_events` rows carry the forged note
`'Fast-tailored and queued from Discovered Jobs Explorer'`. The migration wrote **3** corrections.

Those 18 rows span **3 distinct `application_id`s**. The retraction is one compensating event per
*application*, not per *row*. matched 3, written 3 — the signature of a clean first run. (The
migration reports both counts precisely so the difference is readable: written = matched → first
run; written 0, matched > 0 → correct re-run; anything between → a partial earlier run.)

`application_events` carries `forbid_update` / `forbid_delete` triggers, so a compensating event is
the **only** possible correction. The 18 forged rows are still there and always will be; what
changed is that 3 applications now carry a row saying so.

### 3.2 My verification query was wrong in the way this repo has a rule about

I checked whether the seed bug was fixed with:

    position('evaluation_order' in pg_get_functiondef(...)) > 0

It returned **true after a successful fix**, and I nearly reported a failed migration. The string
survives in the deployed function **inside a comment explaining the bug**:

    -- `sort_order`, NOT `evaluation_order`. The latter has never existed on this
    insert into public.filter_rules (user_id, rule_type, sort_order, config)

The insert is correct. My *check* was not. This is `CLAUDE.md` §3's rule verbatim — **assert on
code SHAPE, never on a bare substring** — and it is the same shape as the `audit_clean` incident,
where a test forbidding a string went red against the comment explaining why the code was removed.

**The lesson generalises past SQL: a guard that forbids naming a bug will fire on the
documentation of that bug, and the documentation is the most valuable thing at a fix site.** The
right query asserts the positive — does the insert name `sort_order`? — which came back true.

---

## 4. Corrections this pushes into other docs

- **`CLAUDE.md` §8 "`filter_rules` is empty and unconfigurable"** — now wrong in a third way.
  Both users are seeded, 9 rows each. Of reason (c), *"every seeded rule config is `{}`"*: it is
  **8 of 9**, not all — `staleness` carries `{"treat_unknown_posted_at_as_fresh": false}`. Close
  enough to be quoted as "every", which is how a claim drifts from nearly-true to false.
- **The two rules that still cannot fire are unchanged by this push.** `experience_ceiling` and
  `degree_mismatch` are now seeded rows with `enabled: true` and `config: {}` — so they look
  healthier than before while remaining structurally inert, because `toJobInsert` still never
  populates `min_experience_years` or `requires_advanced_degree`. **Seeding made the dead rules
  more convincing, not more functional.**
- **`20260910220800`'s `create policy` / 42710 hazard never came near firing**, as predicted — the
  file was already applied and `db push` did not re-run it. The pre-flight the 09-17 runbook was
  built around was correctly retired.

---

## 5. What this does and does not unblock

**Does:** a new signup's defaults now seed correctly *if something calls the function*. The INSERT
status guard is live, closing the hole where `before update` left inserts unguarded.

**Does not:** **nothing calls `bootstrap_user_defaults()`** — no caller in `apps/web/src`,
`worker/src` or `supabase/functions`, and no trigger on `auth.users`. The backfill in this
migration seeded the two *existing* users by hand. **A third signup still gets nothing.** Repairing
a function nobody invokes fixes the function, not the flow.
