# Handoff: tailoring rework session (2026-11-18, 21:23-23:50 IST)

Separate session from the orchestrator applyyy-61 [fbed2c] and its peers (screener / discovery /
Lever / dedupe). This session owned only tailor, resume-assist, the Gemini client, the approval
chat and resume-template files. It never messaged the peers (Teja: "don't touch the other peers").

Read first: [docs/tailor/README.md](../tailor/README.md), then
[2026-11-18-tailoring-findings-and-plan.md](../tailor/2026-11-18-tailoring-findings-and-plan.md)
(data, rulings, plan) and [2026-11-18-architecture-changes.md](../tailor/2026-11-18-architecture-changes.md)
(what changed and why).

## Shipped (committed + pushed)

| SHA | What | Deployed? |
|---|---|---|
| b221126c | docs/tailor findings + plan (361 chat edits, 108 tailored resumes, 47 masters analysed) | docs only |
| 77ff4d03 | Resume chat: SSE streaming, NDJSON progress, fail-fast `interactive` Gemini mode, note-first schema, cache-friendly prompt order, web stream reader + live status | **web: yes (Vercel on push). `resume-assist` edge function: NOT deployed** |

Gates at 77ff4d03 (re-run by this session): functions 182/182, deno check 3 files, web tsc + test
tsc + vite build exit 0, web 1622/1622.

## Durable work outside the repo

`C:\Users\tejam\applyyy-handoff-keep7-2026-11-18\` (personal data: never commit):
- `tailor-analysis/` A-D reports (chat patterns, tailored audit, master history, tailor code map) + raw dumps
- `retailor5/` SPEC.md, check.js (provenance checker, proven on planted errors), 33 `appN-ideal.json/.md`
  (Claude-written ideal resumes, all CLEAN), WRITE-PATH.md (recon of the safe write), probe/convert scripts,
  `backup-queue-2026-11-18.json` (every awaiting_approval row's tailored_profile before any write)
- `chat-latency/CONTRACT.md` (the streaming contract), `render-qa/` (Certifications/Achievements layout QA, D1-D9)

## Pending (ordered)

1. **Deploy `resume-assist`** from a clean export of 77ff4d03 (repo CLAUDE.md §3). Then verify live: a chat
   message streams status + text; `resume_chat_messages.usage.cached` > 0 on a second message (caching
   unverified; may need a fixed key per chat or a model that supports implicit caching).
2. **Approval-queue re-tailor write**: see the section below for its state at shutdown.
3. **Swap rule fix** (end-state rules): the BlackRock case "remove irrelevant Aczen bullet + add the CI/CD
   AuthScore bullet" dead-ends ("exp_aczen: 3 bullets, needs 4" then "would run past one page"). Fix: check
   content rules + page fit on the end state of the change set; offer the swap. Builder was stopped before
   editing anything. Spec: architecture-changes.md §4.
4. **Certifications/Achievements layout** (render-qa D1-D3): run-in achievement font not scaled by page-fit
   (`print-styles.ts:338`, `page-fit.ts` stepStylesheet); certs all-bold + whole line linked
   (`render-resume-html.ts:402`); no hanging indent; preview margin 14 mm vs PDF 7-8 mm (`renderPreview.ts:109`).
5. **Tailor build** (plan §5, parcels in plan §8): skill preference profile (core + JD fill + never-list),
   compact 2-line skills block, relevance ordering, AI-written bullets with ref-trace validator, Aczen title
   allow-list (also on the chat's `set_role`; its prompt example literally says "Data Analyst Intern",
   `resume-assist/assist.ts:545`), headline = the job-title segment of the JD title, per-JD summary.
   Golden set = the 33 ideals + 64 chat-edited resumes.
6. **Chat resilience**: pause a key after N consecutive 429s (key 11 had 37), optional fast path for plain
   skill commands (proposed, not chosen yet), first-chunk timeout.
7. **Master fixes for Teja** (cannot be done by code): add "Java + Spring Boot" to `bullet_one1on1_backend`
   + a Spring Boot skill (lifts ~5 Java jobs); name Python in AuthScore/F1 bullets; a Node variant of the
   One-on-One project (no AWS claim: `1on1` has no AWS resources); CGPA (Canonical screens on grades);
   fix `variant-backend-fullstack` (says Socket.IO/containers, bullets say STOMP); label master versions.
8. **Screener leaks seen in the queue**: ElevenLabs requires GMT-5..GMT+1 (location "Remote" passed);
   Point72 BA wants 4+ years; Fractal's JD is 513 chars of boilerplate.

## Rulings captured this session (Teja, 2026-11-18)

Skills = core + JD fill; compact skills block; per-JD summary with JD title as headline (job-title
segment only); One-on-One variant follows the JD stack; AI writes bullets, Aczen title and headline;
Aczen title allow-list (21:55); most-needed first in skills, groups, projects, achievements; fix
Certifications/Achievements layout; chat fixes 2,3,4,5 (not the fast path); floors stay but are
checked on the end state.
