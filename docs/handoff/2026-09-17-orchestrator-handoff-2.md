> **Historical record as of 2026-09-17.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Orchestrator handoff #2 — 2026-09-17, 17:50 IST

**From:** `applyyy-94` (second orchestrator of the day) · **To:** whoever runs this next
**Repo state:** everything committed and pushed. Peer sessions closed by Teja at ~17:50.

Read [`CLAUDE.md`](../../CLAUDE.md) first — it absorbed **nine commits today** and is where the
durable findings live. This file holds only what is *not* in it: what is decided, what is owed,
and what I got wrong so you don't re-derive it.

The first handoff ([`2026-09-17-orchestrator-handoff.md`](2026-09-17-orchestrator-handoff.md))
is still accurate as history. **Its header says HEAD is `e2bad26`; it was already `b30ce1f` when
I read it.** Treat both files as dated, not current.

---

## 1. The one thing blocking everything

**No session can see the live database.** The Supabase MCP connector needs an OAuth flow and
every session here is non-interactive. The Vercel CLI is not installed either.

So **every claim about migration state made today — by anyone — is inferred from filenames.**
Say that out loud rather than letting a reader assume it was checked.

**Teja's next step is applying the migrations.** It is unblocked from our side:

- The backlog is **eight** files — seven inherited (not the *two* everyone said all afternoon) plus
  the retraction migration `bb6a988`, which sorts last. `supabase db push` applies **all of them in
  one command**, and **it needs no Docker** — `db push` is a network operation; only
  `start`/`reset`/`diff` need containers. The no-Docker rule was never the obstacle.
- **The seven inherited files are reviewed and cleared**, zero SQL edits proposed —
  [`audit/2026-09-17-unapplied-migrations-review.md`](../audit/2026-09-17-unapplied-migrations-review.md).
  **The eighth is self-reviewed only.** See §3.1.
- The risk is **ordering, not content**. `20260910220800_create_private_storage_buckets.sql` is
  first, writes four `create policy` statements against `storage.objects` (a table owned by
  `supabase_storage_admin`), and is the only file with no re-run guard on its main statements.
  **Its own comment at `:43-45` claims re-running is safe; that is true of the bucket insert and
  false of the file.** Postgres has no `create policy if not exists`, so a second run raises
  **42710**. It gates the other six.
  **Do not pre-emptively patch it.** Bare `create policy` is house style (`rls_policies.sql`: 17
  creates, 0 drops), and editing a migration to fix an unconfirmed problem is exactly how the
  `evaluation_order` bug got in. The review's pre-flight answers in one second whether those four
  policy names already exist; fix only if it returns rows. Corrected SQL is in its §3.1.
- Run `supabase migration list` **first**, then the pre-flight, then the baseline query **before**
  the push. A count taken only afterwards cannot tell *"seeded 18"* from *"was already 18"* —
  precisely the bug `20260917124500` exists to fix.
- **Verdicts are not uniform.** Six are high-confidence; **file 1 is MEDIUM on whether it applies
  cleanly** (high on correctness), and **file 6 is LOW on effect** (high on SQL — it can run green
  and change nothing). **The bad resting places if the push dies are files 5 and 6, not 4**: file 4
  installs the `evaluation_order` break and file 6 repairs it, so stopping between them leaves the
  fix half-landed. Recoverable — nothing calls that function — but not a state to walk away from
  believing it was clean.

**Do not repeat the "LIVE BREAK" framing.** If `20260912001500` is also unapplied, the
`evaluation_order` break never fires — both apply seconds apart in the same push and the broken
function is never called in between. The honest claim is *"we cannot see the database"*, not
*"your database is broken"*. Under-claiming costs a follow-up; overstating costs the credibility
of everything else in the report.

---

## 2. Decided today — do not reopen

| Decision | Ruling | Who |
|---|---|---|
| The `audit_clean` fast-path button | **Delete it.** Shipped `75a75a0` | Teja, 16:55, re-confirmed ~17:40 to a second session |
| The forged audit history | **Write a compensating event.** Written and shipped `bb6a988`; **needs a second reader** (§3.1) | Teja, 16:55 |
| Playwright verification | **Defer to CI deliberately.** Shipped `b62be33` | Teja 17:37, re-ruled by me when he delegated |
| The tier scheme rewrite | **Bundle it with W2**, not standalone churn | me |
| Test comment-density band | **Description, not a ceiling.** Only the ≥1.00 source floor is a requirement | me |
| Partition map ownership | **`applyyy-94`**, chosen over `applyyy-92` | Teja, ~17:40 |

---

## 3. Still owed — ranked

1. **A SECOND READER FOR `20260917174600_retract_forged_fast_path_agent_events.sql`** (`bb6a988`).
   The compensating-event migration is **written** — this is the *review* that is owed, and it is
   now the top item. Its author flagged plainly that §9 of the review doc is a **self-review** and
   said it should not clear its own file. **Nobody else has read it, and the sessions closed.**
   It is low-risk by position — it sorts **last of eight**, so if it fails everything else has
   already applied and the forged history is merely un-retracted. But read it before pushing.
   What it does, so a reviewer starts informed: discriminator is
   `detail->>'note' = 'Fast-tailored and queued from Discovered Jobs Explorer'` on
   `event_type='note'` — verified unique (`git log -S` returns only `ab05ba4` which added it and
   `75a75a0` which removed it), and no UI lets a human type a note. **No manual id list needed.**
   Idempotent via a stable `detail->>'correction'` marker. Reports **both** matched and written
   counts, and `raise warning` (not `exception`) on zero matches.
   Two design points worth preserving if it is revised: it **aggregates from the data instead of
   templating** — the button `throw`s on the first failing step, so a partial click forged fewer
   than six transitions and a hard-coded "six" would be false exactly for the rows where something
   had already gone wrong. And it carries `user_id` from the source row because **`auth.uid()` is
   NULL inside a migration**, which would otherwise abort the file.
2. **`ApprovalQueuePage.tsx:214` null-check → shape check**, deleting the now-unreachable fallback
   at `:223-245` in the same pass. Mechanism in
   [`status/2026-09-17-pending-work-audit.md`](../status/2026-09-17-pending-work-audit.md) §5.2.
3. **Is production serving current code?** Never answered. The build is green at HEAD, so the
   09-12 mechanism is absent — but that is a different claim. The test: open
   `https://applyyy.vercel.app`, take the `/assets/index-*.js`, search for
   `Nothing compared these against your master profile`. Absent → stale deploy.
4. **W2 (vite) and W4 (vitest, alone, last).** W2 will not zero the vite count.
5. **The Actions-budget flag.** `scout.yml`/`keepalive.yml` install with no browser cache and no
   skip-download env, while `pnpm-workspace.yaml` permits playwright's postinstall. If it
   downloads, scout has been pulling ~130MB four times a day against the 2,000-minute budget
   `PROJECT_PLAN.md` §2 calls the binding constraint. **Unverified; pre-existing if real.**
6. **Nothing builds `apps/web` in CI.** The 09-16 post-mortem's own action item, still unimplemented.

**Still owed by Teja:** agent identity Gap 1 (frontend lands first), `salary_period` (gate built and
inert — no period column exists), whether the DB or the UI seeds the nine default blocked titles.

---

## 4. What I got wrong, so you don't inherit it

I published **five** wrong claims today and workers caught every one. The pattern is the lesson.

1. **Relayed a peer's audit without opening the source.** Put *"playwright appears in no security
   doc"* into `CLAUDE.md` **and** into a work brief. The plan names it in four places as Window 3,
   and `99c42e8` deferred it deliberately, saying so in its own commit message. **Quote before you
   attribute applies to a peer's findings exactly as it applies to a user instruction** — and note
   the shape of the question ("what is not written down anywhere?") invites exactly that answer.
2. **Told a worker to replace a host allowlist with the live robots gate.** Would have made the repo
   *more permissive*: `jobs.lever.co` disallows `ClaudeBot`, we identify as
   `applyy-fixture-capture`, so the gate selects the `*` group, finds no restriction, and **allows**
   a host a human deliberately excluded. → §5: *a redundant-looking control may be answering a
   different question.*
3. **Named the wrong mechanism** for the `'{}'` gate hole. Past the `continue` at `:214` the value
   is non-null by construction, so the fallback is unreachable dead code. A fix briefed off my
   version would have been aimed at the wrong line.
4. **Pre-wrote the conclusion.** Told a worker to establish "no regression" *and to say it in those
   words*, before anyone knew the work would support it. It couldn't, and refused. → §5: *a brief
   that specifies the conclusion invites the conclusion.*
5. **Named one of three workflows** — immediately after writing the rule that says name the
   workflow. `apply.yml` is not first contact; `scout.yml` installs eight hours earlier and submits
   nothing. → the rule now says name the **set**.

**The meta-lesson:** I wrote the warning about stale claims into `CLAUDE.md` and then put wrong
claims into it within the hour. What actually caught them was not care — it was **workers with real
context reading the source and pushing back**. Partitioned peers do that; task-executors do not.

---

## 5. Running this, mechanically

- **The partition map is a LEASE, NOT A RECORD.** The roster turned over three times in fifteen
  minutes; I wrote three briefs off one `ListAgents` and two recipients had died before I sent them.
  **Re-derive it every time, and timestamp it inside every brief.**
- **Put the state you reasoned from into the ruling** — timestamp and evidence — so a recipient can
  tell a current instruction from an overtaken one.
- **Authorising work is not assigning the writer.** Two separate acts. Do both, explicitly.
- **Verify every peer claim**, including another orchestrator's. Especially another orchestrator's.
- **A trailing line at the end of a status report does not get acted on.** The database blocker
  travelled all afternoon that way and only moved when it became the single ask. I formatted it
  badly four times before noticing.
