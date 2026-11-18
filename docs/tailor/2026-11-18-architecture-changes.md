# Tailoring + resume chat: architecture changes and why (2026-11-18)

Companion to [2026-11-18-tailoring-findings-and-plan.md](2026-11-18-tailoring-findings-and-plan.md)
(the data, rulings and plan). This file records WHAT changed in the architecture, the
pattern each change uses, and WHY, so nobody "simplifies" it back.

## 1. Resume chat: streaming, fail-fast, cache-friendly prompt, honest progress (shipped in code)

### Before
`web -> supabase.functions.invoke('resume-assist') -> one Gemini call -> JSON` behind a fixed
"Thinking…" line. Per attempt 20 s, up to 3 attempts, overload backoff up to ~25 s: worst case ~85 s.
Measured 2026-11-18 22:18-22:23 IST: two failures took **42 s and 67.5 s** before "The AI is busy";
successes took 6.5-9.7 s; `usage.cached` null on every call.

### After
```
web (aiEdit.requestAssist, onProgress)
  -> edgeCall.invokeEdgeStream  [Accept: application/x-ndjson, bearer + apikey, refresh-once on 401]
  -> resume-assist (assist.ts answerFor = one body builder for BOTH paths)
       -> generateGeminiContent({ interactive, onAttempt, onText, timeoutMs 15s, maxRetries 2 })
            -> :streamGenerateContent?alt=sse (SSE parsed with getReader; usage from the last chunk)
  <- NDJSON lines:
     {"type":"status","stage":"thinking|retrying|switching_model","text":...}
     {"type":"note","text":<reply so far, cumulative>}
     {"type":"result","httpStatus":N,"body":<exactly the JSON path's body>}   // always last
```

| Change | Pattern | Why |
|---|---|---|
| `interactive` mode in the Gemini client: first 503 switches to the fallback model with **no sleep**; gaps capped at 1.5 s total | **Fail fast** for interactive calls; batch agents keep the patient schedule | A 503 "high demand" is per MODEL (probe 2026-10-06), so waiting on the same model wastes the user's time; a person at a keyboard prefers a fast honest error to a minute of spinner |
| Stream Gemini (SSE) and forward NDJSON | **Streaming / progressive disclosure** | Same total time, but words appear while the model writes; perceived latency drops |
| `onAttempt` hook -> `status` lines ("Gemini is overloaded - trying the backup model...") | **Observable retries** | The spinner hid retries and model switches; now the user sees what the system is doing |
| Response schema puts `note` first (`propertyOrdering: ["note","ops"]`) + `partialNote()` extractor that never emits half an escape | **Schema ordering for streamability** | JSON mode writes keys in schema order; the human-readable field must come first or nothing streams until the end |
| Prompt order JOB, RESUME, CHAT, INSTRUCTION (content unchanged) | **Stable-prefix-first** for implicit prompt caching | Gemini caches on an identical prompt prefix (min ~1k tokens). Master-minus-resume lines change after every edit, so they stay with RESUME. Verify live: `usage.cached > 0` after deploy |
| Streaming is opt-in by `Accept` header; the web reads JSON too | **Backward-compatible contract** (tolerant reader, opt-in producer) | Vercel deploys web on push, possibly before the edge function ships; either side can deploy first |
| One `readAssistBody()` reader for the JSON body and the stream's `result.body` | **Single source of truth for parsing** | Two readers drift; the old A1 bug (raw operator text shown as AI words) must not come back on one path |
| SSE read with `getReader()` loop, not `for await` | Portability | CI type-checks shared code against the web DOM lib, which has no async iterator on `ReadableStream` (TS2504) |
| Meter waits for the Gemini call, not the Response | Correct accounting | A streamed Response returns before the call ends; the usage row was being written as "gemini call threw" |

Not done (deliberate): an "abort if no first chunk in 8 s" timer (belongs in the client; add if
measurements show hung first bytes). A deterministic **fast path** for plain skill commands
("rm vscode") was proposed and NOT chosen by Teja this round.

## 2. Truth model: generate freely, verify strictly

AI may now rewrite bullets, the summary, the headline and the Aczen title (Teja, 2026-11-18).
Freedom is only safe with a verifier the writer does not control (**generator-verifier /
provenance**): every bullet and summary cites master source ids, and every number and every
technology name in the text must appear in the cited sources. Aczen title comes from a closed
allow-list (Full Stack AI Engineer Intern, Software Engineer Intern, Backend Engineer Intern,
AI Engineer Intern; approved 21:55). Prototype verifier: `scratchpad/retailor5/check.js`
(proven on planted errors; whole-word tech matching so 1-letter skills like "C" cannot pass
vacuously). It becomes the production validator in the tailor build.

## 3. Re-tailoring the approval queue: two-layer write (in progress)

Stored row = two columns of different types (recon 2026-11-18):
- `tailor_refs` (TailoredProfile): the "original". The approval page REBUILDS the original from it
  through the validator, whose word-trace allows only a bullet's own master words. AI-written
  text there fails, and editing switches off for the row.
- `tailored_profile` (ResolvedResume): what prints. Text is free (non-blank, <= 2000 chars);
  the Aczen title lives in `experience[].role`.

So the converter writes **master text in `tailor_refs`** and the **AI text + title on top in
`tailored_profile`** (**two-layer projection**: verified base + presentation overlay). One
UPDATE per row filtered by id + `status='awaiting_approval'` + `updated_at` (optimistic
concurrency, the same guard the web's own save uses), `master_version = 47`, and a `note` event
with the row's `user_id` (`auth.uid()` is NULL under service role). Backup of every row taken
first: `scratchpad/retailor5/backup-queue-2026-11-18.json`.

Not representable without a master change: custom skill-group names (groups print by master
category) and moving a skill between groups (e.g. Loop Engineering to AI).

## 4. Rules as end-state invariants, not per-operation vetoes (next)

Live case 2026-11-18 (BlackRock chat): Teja asked to swap an irrelevant Aczen bullet for a
CI/CD one. Removing was refused ("exp_aczen: 3 bullets, needs 4") and adding was refused
("would run past one page"), so the swap could never happen. Each rule was checked against the
state after ONE operation. Fix: evaluate the content rules and page fit on the **end state of the
whole batch** (remove + add together), and when a lone remove would break a floor, offer the swap
instead of a dead end. The floors themselves stay (they are Teja's rulings); only where they are
checked changes.
