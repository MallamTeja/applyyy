# Board re-probes — 2026-10-24 (~11:00 IST)

> **Status 2026-11-08:** Partly superseded. The PhonePe verdict (SmartRecruiters `PHONEPELIMITED`) no longer leads to polling: SmartRecruiters is OFF by the 2026-11-01 robots ruling (its robots.txt is `Disallow: /`); the adapter was unregistered (fc5097f) and deleted (2fe0264), and every live `smartrecruiters` watchlist row is disabled. The Redpanda, Fi and Dream11 verdicts are point-in-time. Current truth: [README.md](README.md). The body below is the original record, unedited.

Re-probe of the 4 dead/empty boards flagged "re-probe later" in
the 00:36 orchestrator handoff (deleted as stale 2026-10-24; read it with
`git show f44e209:docs/handoff/2026-10-24-0036-orchestrator-handoff.md`) and
`docs/harvest/2026-10-23-watchlist-expansion.md`. One read-only probe agent per
board; every verdict below is backed by a probe URL + HTTP status + an identity
check (the greenhouse/tcs→Thornbury trap: a 200 can be the wrong company).
Fetched by curl with a browser User-Agent; max 3 attempts per URL; no
credentials or headed browser were needed anywhere.

**Outcome: 2 of 4 boards are alive again — PhonePe (SmartRecruiters, 118
postings) and Redpanda (Ashby, 13 postings). Fi is still valid-but-empty.
Dream11 is still gone.** The watchlist SQL was NOT executed and no
`supabase/snippets/` file was written: the statements were handed to the
orchestrator as text for Teja-gated execution; the "Prepared SQL" section at the
bottom carries the same text.

---

## PhonePe — LIVE on SmartRecruiters, token `PHONEPELIMITED` (118 postings)

Prior state (2026-10-23): greenhouse `phonepe` all-endpoints 404, provider unknown.

| Probe | URL | Result |
|---|---|---|
| greenhouse jobs | https://boards-api.greenhouse.io/v1/boards/phonepe/jobs | 404 |
| greenhouse board | https://boards-api.greenhouse.io/v1/boards/phonepe | 404 |
| greenhouse hosted | https://job-boards.greenhouse.io/phonepe | 404 |
| careers page | https://www.phonepe.com/careers/ | 200; no ATS signature in static HTML; jobs load from own feed |
| own job feed | https://www.phonepe.com/apollo/job-postings/latest.json | 200, `"totalCount": 755`, `fetchedAt` 2026-10-24T05:00Z; statuses PUBLIC 118 / NOT_PUBLISHED 453 / INTERNAL 20 / PRIVATE 10; all 118 PUBLIC apply links point to `https://jobs.smartrecruiters.com/PHONEPELIMITED/...` |
| SmartRecruiters API | https://api.smartrecruiters.com/v1/companies/PHONEPELIMITED/postings?limit=1 | 200, `"totalFound":118` |

Identity: the SR postings response carries
`"company":{"identifier":"PHONEPELIMITED","name":"PHONEPE LIMITED"}`, location
"Bengaluru, Karnataka, India" (Salarpuria Softzone, Bellandur, 560103),
industry "Financial Services"; newest posting "Manager, Brand Marketing"
released 2026-10-23. Count agreement (118 = 118) plus phonepe.com's own feed
linking straight to the SR board makes this high-confidence PhonePe, not a
token collision.

Note on the SR existence check: `GET /v1/companies/PHONEPELIMITED` returns 404
for EVERY company (`Cannot GET /public-posting-api/api-v1/companies/...`) —
that endpoint shape from the 10-23 notes is wrong for bare company GETs;
identity must come from the postings response. The old Google-cache greenhouse
links are explained by a stale phonepe.com JS bundle
(`component---src-pages-careers-jobs-index-js-...`) still templating
`boards.greenhouse.io/phonepe/jobs/<id>`.

**Adapter gap:** no SmartRecruiters adapter exists
(`getAdapter("smartrecruiters")` → null, `_shared/ats/registry.ts`), but
scout-ats SKIPS unsupported-provider rows cleanly (status "skipped",
`scout-ats/index.ts:297`), so a watchlist row is safe today and activates
automatically the day the SR adapter ships. PhonePe (118) joins Canva (97) and
Nagarro (582) as SR-adapter payoff — this strengthens the open SR go/skip
ruling's "go" side.

## Redpanda — LIVE on Ashby, token `redpanda-data` (13 postings)

Prior state was CONFLICTED: one 10-23 note said "Redpanda (ashby)", another
said the careers page net-called greenhouse `redpandadata` and 404'd. Both were
part-right: greenhouse is dead, ashby is live, and the token is
`redpanda-data` — NOT `redpanda` or `redpandadata`, both of which 404 on ashby
(a name-derived guess would have missed it, again).

| Probe | URL | Result |
|---|---|---|
| greenhouse jobs | https://boards-api.greenhouse.io/v1/boards/redpandadata/jobs | 404 |
| ashby (guess 1) | https://api.ashbyhq.com/posting-api/job-board/redpanda | 404 |
| ashby (guess 2) | https://api.ashbyhq.com/posting-api/job-board/redpandadata | 404 |
| careers → jobs page | https://www.redpanda.com/jobs | 200; inline script: `var ASHBY_BOARD = 'redpanda-data';` + fetch of the ashby posting API |
| ashby (page's own token) | https://api.ashbyhq.com/posting-api/job-board/redpanda-data | 200, 13 postings, every `jobUrl` under `jobs.ashbyhq.com/redpanda-data/` |
| ashby hosted board | https://jobs.ashbyhq.com/redpanda-data | 200, `"name":"Redpanda Data"`, `"publicWebsite":"https://www.redpanda.com/"` |

Identity: the hosted board names "Redpanda Data" with publicWebsite
redpanda.com, and redpanda.com/jobs itself ships the token. High confidence.
The stale greenhouse 404 came from a leftover Slater script
(`assets.slater.app/slater/9244/21487.js`) still fetching
`boards-api.greenhouse.io/v1/boards/redpandadata/departments` — the same
stale-embed pattern as PhonePe's old bundle. Sample roles: "Staff Software
Engineer, Cloud" (Warsaw), "Forward Deployed Engineer - US Remote".

## Fi (Epifi) — still VALID BUT EMPTY on lever `epifi`

| Probe | URL | Result |
|---|---|---|
| lever API | https://api.lever.co/v0/postings/epifi?mode=json | 200, body exactly `[]` (0 postings) |
| careers page | https://fi.money/careers | 200 (no redirect, 187 KB); only ATS link is `https://jobs.lever.co/epifi` (×4); no greenhouse/ashby/SR/darwinbox/workday/keka/skillate signature |

Verdict: unchanged from 2026-10-24 00:xx — board valid, 0 postings, lever still
the live portal. Still fails the >0-postings watchlist bar. High confidence.
Keep on the periodic re-probe list; no SQL.

## Dream11 / Dream Sports — still NO PUBLIC BOARD

| Probe | URL | Result |
|---|---|---|
| lever US | https://api.lever.co/v0/postings/dreamsports?mode=json | 404 |
| lever hosted | https://jobs.lever.co/dreamsports | 404 |
| lever EU | https://api.eu.lever.co/v0/postings/dreamsports?mode=json | 404 |
| greenhouse | https://boards-api.greenhouse.io/v1/boards/dream11/jobs | 404 (`"Job not found"`) |
| careers page | https://www.dreamsports.group/careers → /lifeatdreamsports | 200; CTA button still `"ctaButton":"https://jobs.lever.co/dreamsports"` (dead) |

Extra token sweeps: `dream11`, `dreamsportsgroup`, `dream-sports` on lever,
greenhouse AND ashby, plus `dreamsports` on greenhouse and ashby — every one
404. Verdict: no public board on lever/greenhouse/ashby under any plausible
token; the careers page still links its own dead lever board. High confidence
within that scope; a JS-loaded widget or a Darwinbox/Workday portal on its own
subdomain would not show in a static-HTML check. Keep on periodic re-probe; no
SQL.

---

## Prepared SQL (handed to the orchestrator; NOT executed by this pass)

Additive, idempotent (same on-conflict form as
`supabase/snippets/2026-10-24-seed-watchlist-headless-pass.sql`), user resolved
by email because `auth.uid()` is NULL outside a user session. Redpanda is
pollable immediately (ashby adapter exists); PhonePe sits status-"skipped"
until an SR adapter ships.

```sql
-- =============================================================================
-- Re-probe seed 2026-10-24: 2 boards revived (evidence:
-- docs/harvest/2026-10-24-board-reprobes.md).
--   ashby/redpanda-data    Redpanda Data   13 postings, identity-verified
--   smartrecruiters/PHONEPELIMITED  PhonePe  118 postings, identity-verified
--     (no SR adapter yet — scout-ats skips the row cleanly until one ships)
-- =============================================================================
do $$
declare
  -- The owning account; auth.uid() is NULL outside a user session (CLAUDE.md §7).
  v_user_id uuid;
  -- Honest reporting: rows actually written.
  v_inserted integer;
begin
  -- Resolve the account by email, aborting rather than seeding nobody.
  select id into v_user_id
  from auth.users
  where lower(email) = lower('tejamallam00@gmail.com');

  if v_user_id is null then
    raise exception 'ABORTED - no auth.users row for tejamallam00@gmail.com';
  end if;

  -- One row per revived board; slug derived exactly as the three prior seeds did.
  insert into public.company_watchlist (
    user_id, ats_provider, board_token, company_name, company_slug, enabled
  )
  select
    v_user_id,
    b.provider::public.ats_provider,
    b.board_token,
    b.company_name,
    trim(both '-' from regexp_replace(lower(b.company_name), '[^a-z0-9]+', '-', 'g')),
    true
  from (values
    ('ashby', 'redpanda-data', 'Redpanda Data'),
    ('smartrecruiters', 'PHONEPELIMITED', 'PhonePe')
  ) as b(provider, board_token, company_name)
  -- Re-running updates the name and re-enables rather than erroring
  -- (unique key company_watchlist_user_board_key).
  on conflict (user_id, ats_provider, board_token) do update set
    company_name = excluded.company_name,
    enabled = true;

  get diagnostics v_inserted = row_count;

  -- Matched vs written, reported (repo DB rule: counts, not silence).
  raise notice 'Re-probe seed: wrote % row(s) (expected 2).', v_inserted;
end
$$;

-- Verification read: expect ashby +1 and smartrecruiters = 1 (its first row).
select ats_provider, count(*) as boards
from public.company_watchlist w
join auth.users u on u.id = w.user_id
where lower(u.email) = lower('tejamallam00@gmail.com')
group by 1 order by 1;
```

## Follow-ups outside this pass's write partition

- `apps/web/src/features/settings/companyCatalog.ts` was updated in the same
  commit as this doc, under a new `BOARD_PROBE_DATE_2026_10_24` constant:
  PhonePe → smartrecruiters/`PHONEPELIMITED` on the `no-board-found` arm with a
  `confirmed` SR portal (the Canva/Nagarro precedent: no SR adapter, so not
  pollable); Dream11 → re-confirmed dead. Redpanda and Fi have NO catalog rows,
  and none were added: a new row needs editorial fields (category, domain,
  cooldown) that this probe did not measure.
- SR adapter ruling (open on Teja): payoff is now Canva 97 + Nagarro 582 +
  PhonePe 118 = ~797 postings.
- Periodic re-probe list stays: Fi/epifi (valid, empty), Dream11 (dead),
  PhonePe-greenhouse leftovers need nothing.
