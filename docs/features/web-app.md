# Web app reference (`apps/web`)

_Last verified against code: 2026-11-08 (2936e8c)._

This page maps every screen of the operator console. For each folder in
`apps/web/src/features/` (and the shell in `apps/web/src/app/`) it says what the
user does there, the route, which tables, RPCs and edge functions it calls, the
key files, and the tests that cover it.

All paths are relative to `apps/web/` unless they start with `supabase/`.

## How to regenerate the facts on this page

This page names things; it does not count them. Run these to see the current set.

| Fact | Command (repo root, Git Bash) |
| --- | --- |
| Routes in the rail | `git show HEAD:apps/web/src/app/routes.ts \| grep "path:"` |
| Routes the router mounts | `git show HEAD:apps/web/src/App.tsx \| grep "Route path"` |
| Tables a feature reads or writes | `git grep -oE "\.from\('[a-z_]+'\)" HEAD -- apps/web/src/features/<area>` |
| RPCs a feature calls | `git grep -oE "\.rpc\('[a-z_]+'" HEAD -- apps/web/src` |
| Edge functions a feature calls | `git grep -oE "invokeEdge\([a-z]+, *'[a-z-]+'" HEAD -- apps/web/src` |
| Web tests | `git ls-tree --name-only HEAD apps/web/test/` |

Run the web tests with `node --test "test/**/*.test.ts"` from `apps/web/`
(the `test` script in `package.json`). Typecheck and build with
`./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`.

## Rules that every screen follows

- **Routes are data.** `src/app/routes.ts` holds the rail sections and their routes.
  The rail, the page titles (`PageHeader`) and the command palette all read it.
  `src/App.tsx` mounts each page under the same path. `test/routes.test.ts` checks
  that the two agree.
- **Every status change goes through the RPC.** Screens never `UPDATE
  applications.status`. They call `advance_application_status` with `p_agent` set
  to `human` (for example `features/health/advanceRecovery.ts:109`,
  `features/discovery/rejectJob.ts:99`). The DB checks the edge against
  `application_status_transitions`.
- **Every edge-function call goes through `invokeEdge`** (`src/data/edgeCall.ts:82`).
  It refreshes a revoked session once. If that fails, it signs this browser out with
  one plain sentence (`SIGNED_OUT_MESSAGE`). Test: `test/edgeCallSites.test.ts`,
  `test/sessionRefresh.test.ts`.
- **Every page has its own error boundary** (`guarded()` in `src/App.tsx`, built on
  `src/app/ErrorBoundary.tsx`). A crash on one page keeps the nav rail alive.
- **No native browser dialogs.** Use `src/app/InlineConfirm.tsx` for a confirm step.
  Test: `test/inlineConfirm.test.ts` (an AST scan of `src/`).
- **Every stored URL in an `href` passes `safeHref`** (`src/app/safeHref.ts`), so a
  `javascript:` link from a job board cannot run. Test: `test/safeHref.test.ts`.
- **Pure rules live in `.ts` files beside the page.** `apps/web` has no DOM test
  library. Logic that must be tested sits in a pure module (for example
  `queueView.ts`, `appliedView.ts`, `emailView.ts`). Component output is tested with
  `react-dom/server` through `test/support/registerTsxHooks.ts`. Browser behaviour is
  tested in the Playwright suites (`test/*E2e.test.ts`, `test/e2eSuite.test.ts`).

## Route map

| Rail section | Route | Page component | Feature folder |
| --- | --- | --- | --- |
| Operations | `/approvals` (default, `DEFAULT_ROUTE`) | `ApprovalQueuePage` | `approval/` |
| Operations | `/pipeline` | `PipelinePage` | `pipeline/` |
| Operations | `/applied` | `AppliedJobsPage` | `applied/` |
| Operations | `/discovered` | `DiscoveredJobsPage` | `discovery/` |
| Operations | `/manual-apply` | `ManualApplyPage` | `manual-apply/` |
| Operations | `/health` | `HealthPage` | `health/` |
| Operations | `/emails` | `EmailMonitoringPage` | `emails/` |
| Operations | `/referrals` | `ReferralOutreachPage` | `referral/` |
| Operations | `/nudges` | `FollowUpNudgesPage` | `followup/` |
| Operations | `/skill-gap` | `SkillGapPage` | `analytics/` |
| Configuration | `/search-preferences` | `SearchPreferencesPage` | `settings/` |
| Configuration | `/master-profile` | `MasterProfilePage` | `settings/` |
| Configuration | `/answer-bank` | `AnswerBankPage` | `settings/` |
| Configuration | `/filters` | `FiltersPage` | `settings/` |
| Configuration | `/watchlist` | `WatchlistPage` | `settings/` |
| Configuration | `/blocklist` | `BlocklistPage` | `settings/` |
| (none) | `/` | redirects to `/approvals` | `src/App.tsx` |
| (none) | any other path | `NotFound` ("Page not found") | `src/App.tsx` |

Folders with no route of their own: `auth/` (the sign-in gate), `resume-preview/`
(shared component), `profile/` (PDF extraction helper).

## Shared data layer (`src/data/`)

The features call these modules instead of repeating the logic.

| Module | What it does |
| --- | --- |
| `supabase.ts`, `supabaseConfig.ts` | The one Supabase client. It is `null` when the env vars are missing, and every caller handles that. |
| `edgeCall.ts` | `invokeEdge`: the only way the browser calls an edge function. |
| `useAuth.ts` | Sign in, sign up and sign out with email and password; listens to `onAuthStateChange`. |
| `contract.ts` | Re-exports the shared schema types and status list from `@applyy/shared-types`. |
| `humanLanes.ts` | Which status edges only a human can take, and which screen offers a control for each. Feeds the rail warning and the Health coverage panel. |
| `useApplicationCounts.ts`, `statusCounts.ts` | Per-status counts from the `application_status_counts` RPC. |
| `useAgentRuns.ts`, `agentFreshness.ts`, `ruleWarnings.ts` | Reads `agent_runs` and decides whether each agent is fresh or stale. |
| `pipelineRunner.ts` | Runs `normalizer`, `screener`, `matcher`, `tailor`, `auditor` in order, and reads each answer against its real shape. An unknown shape counts as a failure. |
| `discoveryService.ts` | Asks `scout-ats` to scan the watchlist. The browser scan fallback was removed on 2026-11-01. Remote feeds run on `.github/workflows/scout-remote.yml`, not in the browser. |
| `readState.ts` | Shared "loading / empty / error" wording. |
| `keyRole.ts` | Reads the `role` claim of the Supabase key. `supabase.ts` refuses to build a client unless it is `anon`, so a service-role key can never ship in the bundle. |

---

## App shell (`src/app/`)

**What the user does.** Signs in, moves between screens with the nav rail, opens
the command palette, and switches the theme.

**Route.** Wraps every route as the layout route (`<Route element={<AppShell />}>`
in `src/App.tsx`).

**Calls.**
- RPC `application_status_counts` (via `useApplicationCounts`) for the rail badge.
- The Manual apply page's own loader (`loadManualApply('badge')` from
  `features/manual-apply/manualApplyData.ts`), so the "needs you" badge counts the
  same rows that page lists. If that read fails, the badge falls back to the lane
  counts, never to a made-up zero.
- Supabase Auth through `useAuth`.

**Key files.**

| File | Role |
| --- | --- |
| `AppShell.tsx` | The frame. Shows `LoginPage` when no one is signed in. Renders the rail, the Manual apply badge, a warning when `MISSING_HUMAN_CONTROLS` or `UNBUILT_HUMAN_CONTROLS` is not empty, and the sign-out button. |
| `routes.ts` | `OPERATIONS_SECTION`, `CONFIGURATION_SECTION`, `ALL_ROUTES`, `DEFAULT_ROUTE`. |
| `CommandPalette.tsx` | Opens on Ctrl+K or Cmd+K. Lists every route from `ALL_ROUTES`. |
| `PageHeader.tsx` | Page title plus the one-line lede taken from `routes.ts`. |
| `ErrorBoundary.tsx` | Per-page crash boundary. |
| `InlineConfirm.tsx` | In-place "are you sure?" control (replaces `confirm()`). |
| `Toast.tsx` | `ToastProvider` and `useToast` for short success, error and info messages. |
| `ThemeToggle.tsx`, `theme.ts` | Light, dark or system theme, stored per browser. |
| `StatusBadge.tsx`, `SourceBadge.tsx` | Status pill and job-source pill. |
| `safeHref.ts` | http(s)-only link gate. |

**Tests.** `routes.test.ts`, `theme.test.ts`, `inlineConfirm.test.ts`,
`safeHref.test.ts`, `sourceBadgeDedupe.test.ts`, `manualApplyBadge.test.ts`,
`needsYouQueues.test.ts`, `humanLanes.test.ts`, `statusCounts.test.ts`,
`noEmoji.test.ts`, `noJsxCommentText.test.ts`.

---

## `auth/` - sign-in gate

**What the user does.** Signs in (or signs up) with email and password. There is
no pre-filled email: a hard-coded address once shipped in the public bundle
(see the header of `src/data/useAuth.ts`).

**Route.** None. `AppShell.tsx` renders `LoginPage` in place of any page when no
valid session exists.

**Calls.** Supabase Auth only: `signInWithPassword`, `signUp`, `signOut`,
`getSession`, `onAuthStateChange` (`src/data/useAuth.ts`). Row Level Security on
every table limits each user to their own rows.

**Key files.** `LoginPage.tsx`, `src/data/useAuth.ts`.

**Tests.** `auth.test.ts`, `sessionRefresh.test.ts`, `supabaseConfig.test.ts`,
`keyRole.test.ts`.

---

## `approval/` - Approval queue

**What the user does.** Reviews each tailored resume at `awaiting_approval` and
approves it or sends it back. The page has two buckets
(`ApprovalQueuePage.tsx` header):

- **Bucket B** (any untraceable claim) comes first. Each row is a full diff card,
  open by default. The user may fold a card ("Hide review"); folding never approves.
- **Bucket A** (every line traced) is shown as a count with one button.

On a card the user can also: edit the resume by hand; attest a skill or a new
bullet the master does not have (it goes into the master first, as a new version);
chat with the AI, which proposes and applies edits; sort, filter and search the
queue; and preview the resume.

Rules that matter:
- Every saved edit is fitted to **one page** before it is saved, using the same
  trimmer the tailor uses (`pageFitEdit.ts`, which calls
  `supabase/functions/_shared/tailor/page-trim.ts`).
- Approving an **edited** row re-runs the auditor's check and holds for a second
  click when it finds a problem (`approveCheck.ts`).
- After an approve, the page asks `dispatch-apply` to start the runs. The function
  decides what to start (the kit builder always; the live applier only when
  `system_settings.auto_apply_on_approve` is on) (`dispatchApply.ts`).

**Route.** `/approvals` (the default route).

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `applications` (read queue rows; write `tailored_profile`) | `ApprovalQueuePage.tsx`, `saveTailoredEdit.ts` |
| Table | `application_events` (the edit record, written after the resume) | `saveTailoredEdit.ts` |
| Table | `master_profiles` (via `settings/masterStore.ts`) | `attestSkill.ts`, `attestBullet.ts` |
| Table | `resume_chat_messages` (AI chat memory; the browser writes it) | `resumeChat.ts` |
| RPC | `advance_application_status` (`p_agent: 'human'`) | `ApprovalQueuePage.tsx` |
| Edge function | `resume-assist` (AI chat answers and edit ops) | `aiEdit.ts` |
| Edge function | `dispatch-apply` (start kit build / applier after approve) | `dispatchApply.ts` |

**Key files.**

| File | Role |
| --- | --- |
| `ApprovalQueuePage.tsx` | The page and the two buckets. |
| `DiffView.tsx` | One approval card: job facts, ATS match, audit verdict, changes. |
| `AiEditPanel.tsx`, `aiEdit.ts`, `resumeChat.ts` | The AI chat, its contract with `resume-assist`, and its stored memory. |
| `tailoredEdits.ts` | Pure edit operations on a resume. |
| `saveTailoredEdit.ts` | The one write path for an edit: resume first, then the event. |
| `pageFitEdit.ts` | One-page fit on every save. |
| `approveCheck.ts` | Auditor re-check on approve of an edited row. |
| `attestSkill.ts`, `attestBullet.ts` | Add a skill or bullet to the master, then to the row. |
| `diffAdapter.ts`, `diffModel.ts` | Schema shapes to view model, and the verdict functions. |
| `queueOrder.ts`, `queueView.ts` | Order (newest entry into review first), sort, arrangement filter, search. |
| `dispatchApply.ts` | Calls `dispatch-apply` after an approve. |

**Tests.** `approval*.test.ts` (bucket fold, focus, edits, layout, order, toolbar,
view, stale click, unmounted write, latest sources, JD keyword),
`aiEdit.test.ts`, `aiEditContract.test.ts`, `aiEditE2e.test.ts`,
`dockChatE2e.test.ts`, `approveCheck.test.ts`, `approveRecheckE2e.test.ts`,
`approveDispatchToast.test.ts`, `dispatchApply.test.ts`, `attestSkill.test.ts`,
`attestBullet.test.ts`, `addSkill.test.ts`, `addSkillUi.test.ts`,
`addableSkillMatrix.test.ts`, `diffViewSlim.test.ts`, `skillsGroupedDiff.test.ts`,
`structureEditsUi.test.ts`, `tailoredEdits.test.ts`, `saveTailoredEdit.test.ts`,
`pageFitEdit.test.ts`, `pageFitE2e.test.ts`, `resumeChat.test.ts`,
`findingPathForms.test.ts`, `keywordWordBounded.test.ts`,
`coverageUnmeasured.test.ts`, `coverLetterStaleNotice.test.ts`,
`tailorRefsWithoutSchemaVersion.test.ts`, `printedCredentialsCoverage.test.ts`.

---

## `pipeline/` - Pipeline board

**What the user does.** Sees how many applications sit in each status. Clicks a
status to open a drawer with its rows. From the drawer the user can view a row's
tailored resume, send a `passed_filters` row through matcher, tailor and auditor
("Send through pipeline"), and open the interview prep pack. The board reports; it
does not drive statuses (`PipelinePage.tsx` header). The page can also open the
watchlist scan (`DiscoveryModal.tsx`).

**Route.** `/pipeline`.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| RPC | `application_status_counts` | `PipelinePage.tsx` via `useApplicationCounts` |
| Table | `applications` | `PipelineDrawer.tsx`, `rowPipelineDeps.ts` |
| Table | `interview_prep_packs` | `InterviewPrepPanel.tsx` |
| Edge functions | `matcher`, `tailor`, `auditor` (and `normalizer`, `screener` for a `discovered` row), each called as `<step>?application_id=<id>` | `rowPipelineDeps.ts` |
| Edge function | `scout-ats` (watchlist scan) | `DiscoveryModal.tsx` via `src/data/discoveryService.ts` |

**Key files.**

| File | Role |
| --- | --- |
| `PipelinePage.tsx` | The board of status counts. |
| `PipelineDrawer.tsx`, `DrawerAppCard.tsx` | The drawer and one card in it. |
| `rowPipeline.ts` | One-line re-export of `supabase/functions/_shared/pipeline/row-pipeline.ts` (`DISCOVERED_STEPS`, `PASSED_FILTERS_STEPS`). The engine is shared because `job-link-intake` runs it too. |
| `rowPipelineDeps.ts` | The real dependencies for that engine (edge calls, status read). |
| `resumeSnapshot.ts` | Shape check on `applications.tailored_profile` before "View resume" is offered. |
| `InterviewPrepPanel.tsx` | Reads the prep pack for one application. |
| `DiscoveryModal.tsx` | Watchlist scan dialog. |

**Tests.** `pipelineDrawerScore.test.ts`, `pipelineViewResume.test.ts`,
`drawerSendPipeline.test.ts`, `rowPipeline.test.ts`, `rowPipelineParity.test.ts`,
`pipelineStopReason.test.ts`, `scanBreakdown.test.ts`,
`watchlistScanEmptyBody.test.ts`, `remoteDiscoveryRetired.test.ts`.

---

## `applied/` - Applied jobs

**What the user does.** Sees every application past a confirmed submission. For
each row: its stage, the resume that was sent (and any screenshot), the answers
the system **prepared** for the form, a timeline of status changes and matched
emails, and buttons for the next stage. Search, sort and filter by stage. The
words say "prepared", never "submitted": a kit is what the system prefilled, not
proof of what reached the employer (`submittedDetails.ts` header).

The stages are `APPLIED_STAGES` in `appliedView.ts:29`: `applied`,
`employer_screening`, `oa_pending`, `interview`, `offer`, `rejected`. The stage
buttons come from the human edges in `application_status_transitions`.

**Route.** `/applied`.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `applications` (with job, events and matched emails embedded) | `AppliedJobsPage.tsx` |
| Table | `application_events` | `AppliedJobsPage.tsx` |
| Table | `application_status_transitions` (human edges) | `AppliedJobsPage.tsx` |
| RPC | `advance_application_status` | `AppliedJobsPage.tsx` |
| Storage | buckets `resumes` and `screenshots` (signed URLs) | `AppliedJobsPage.tsx` |

**Key files.** `AppliedJobsPage.tsx`, `appliedView.ts` (pure rules),
`submittedDetails.ts` (newest `apply_kit` note per row), `PreparedAnswers.tsx`.

**Tests.** `appliedView.test.ts`, `appliedPage.test.ts`,
`appliedSubmittedDetails.test.ts`, `appliedE2e.test.ts`.

---

## `discovery/` - Discovered jobs

**What the user does.** Browses scouted jobs in two lanes (`discoveredList.ts`):
**Ready to tailor** (`passed_filters`, opens first) and **Discovered**
(`discovered`). On each card the user can read the full JD as plain text, reject
the job in one click (with Undo), or send it through the agents. Page-level tools:

- **Add a job by link** (`AddJobLinkPanel.tsx`): paste one job URL. The
  `job-link-intake` function adds the row at `passed_filters` and runs matcher,
  tailor and auditor on the server, so closing the tab does not stop it.
- **Web scout** (`WebScoutPanel.tsx`): runs `scout-web` and shows both the
  verified links and the ones the LLM made up.
- **Run pipeline (all eligible rows)** (`PipelineRunModal.tsx`): runs all five
  agents over every waiting row. It fires only after the user types the confirm
  phrase (`pipelineRunConfirm.ts`), because it spends Gemini calls.

**Route.** `/discovered`.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `applications` (with `jobs`) | `DiscoveredJobsPage.tsx` |
| RPC | `advance_application_status` (reject `passed_filters -> dropped_filter`, and undo) | `rejectJob.ts` |
| Edge function | `job-link-intake` | `AddJobLinkPanel.tsx` |
| Edge function | `scout-web` | `WebScoutPanel.tsx` |
| Edge functions | `normalizer`, `screener`, `matcher`, `tailor`, `auditor` | `PipelineRunModal.tsx` via `src/data/pipelineRunner.ts`; per card via `pipeline/rowPipelineDeps.ts` |
| Edge function | `scout-ats` (watchlist scan) | `pipeline/DiscoveryModal.tsx` |

**Key files.** `DiscoveredJobsPage.tsx`, `discoveredList.ts` (lanes, sort,
paging, counters), `jdText.ts` (JD to plain text), `rejectJob.ts`,
`AddJobLinkPanel.tsx`, `WebScoutPanel.tsx`, `PipelineRunModal.tsx`,
`pipelineRunConfirm.ts`.

**Tests.** `discoveredLanes.test.ts`, `discoveredReject.test.ts`,
`discoveredSendPipeline.test.ts`, `discoveredJobsLoadError.test.ts`,
`discoveryNoFastPath.test.ts`, `jdPlainText.test.ts`, `addJobLinkPanel.test.ts`,
`webScoutPanel.test.ts`, `pipelineRunConfirm.test.ts`, `pipelineRunner.test.ts`,
`scoutScheduleFreshness.test.ts`.

---

## `manual-apply/` - Manual apply

**What the user does.** Applies by hand to jobs the bot cannot submit (for example
a captcha board). Each card shows the pre-answered form kit to copy, the resume to
download, and why the bot could not apply. The user can answer the open questions
on the card; the answer is saved to the Answer bank, so it grows
(`botCantApply.ts`). Buttons then move the row (for example to `applied`). A
collapsed **Left your queue** section lists approved jobs that left the live lanes
without being applied, with who moved them and a Re-open button.

A row appears here when it sits in `needs_verification` or `blocked_needs_human`
(`MANUAL_ACTION_STATUSES` in `src/data/humanLanes.ts:445`), **or** when the worker
has written it a kit and it is still open (`manualApplyData.ts` header).

**Route.** `/manual-apply`. The rail badge on this route uses the same loader.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `applications` | `manualApplyData.ts`, `leftQueue.ts` |
| Table | `application_events` (notes with `detail.kind` `apply_kit` or `apply_kit_skipped`) | `manualApplyData.ts` |
| Table | `answer_bank` (via `settings/answerBankStore.ts`) | `ManualApplyPage.tsx` |
| RPC | `advance_application_status` (via `useRecoveryMoves` from `health/RecoveryQueue.tsx`, sources `manual_apply` and `manual_apply_reopen`) | `ManualApplyPage.tsx` |
| Edge function | `dispatch-apply` with `{ kit_only: true }` after an answer is saved, to rebuild the kit | `settings/answerBankStore.ts` |
| Storage | bucket `resumes` (signed download URL) | `ManualApplyPage.tsx` |

**Key files.** `ManualApplyPage.tsx`, `manualApplyData.ts`, `applyKit.ts` (the kit
contract written by the worker's `apply-kit.yml` run), `botCantApply.ts`,
`fieldChoices.ts` (hide long choice lists when the answer matches),
`previewToggle.ts`, `leftQueue.ts`, `LeftQueueSection.tsx`.

**Tests.** `manualApply.test.ts`, `manualApplyBadge.test.ts`,
`manualApplyBotCantApply.test.ts`, `manualApplyKitPending.test.ts`,
`manualApplyQuestionsE2e.test.ts`, `manualApplyResolve.test.ts`,
`manualApplyResolveE2e.test.ts`, `manualApplyResume.test.ts`,
`manualApplyToggleChoices.test.ts`, `leftQueue.test.ts`,
`leftQueueSection.test.ts`, `leftQueueReopenE2e.test.ts`.

---

## `health/` - System health

**What the user does.** Checks that the system is still running. Panels in
`HealthPage.tsx`: Agent freshness, Database connection, Keepalives, Gemini key
pool, Manual control coverage, and four recovery queues. Each recovery queue lists
the stuck rows in one status, with one working button per human move:
`applying`, `needs_verification`, `blocked_needs_human`, `failed`. Moves with no
way back ask for an inline confirm.

**Route.** `/health`.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `agent_runs` | `src/data/useAgentRuns.ts` |
| Table | `applications`, `application_events` | `RecoveryQueue.tsx` |
| RPC | `advance_application_status` (source `health_recovery`) | `advanceRecovery.ts:109` |

**Key files.** `HealthPage.tsx`, `RecoveryQueue.tsx` (also exports
`useRecoveryMoves`, used by Manual apply), `advanceRecovery.ts` (the one write
path), `src/data/agentFreshness.ts`, `src/data/ruleWarnings.ts`,
`src/data/humanLanes.ts`.

**Tests.** `advanceRecovery.test.ts`, `agentFreshness.test.ts`,
`agentRunsBeyondWindow.test.ts`, `healthRuleWarnings.test.ts`,
`ruleWarnings.test.ts`, `humanLanes.test.ts`, `readState.test.ts`,
`receiptMarker.test.ts`, `needsYouQueues.test.ts`.

---

## `emails/` - Email monitoring

**What the user does.** Reads every job email the Gmail tracker captured. Filters
and sorts them (state lives in the URL), marks them read inside the app, refreshes
on demand, and uses **Add to Applied** for a job email about an application the
pipeline does not track. Each email shows its real class label, not a blanket
"Interview Invite" (`emailView.ts` header).

**Route.** `/emails`.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `email_events` (read; write `read_at` and `matched_application_id`) | `EmailMonitoringPage.tsx` |
| Table | `agent_runs` (last successful `tracker` run) | `EmailMonitoringPage.tsx` |
| Table | `applications` (match by company slug) | `EmailMonitoringPage.tsx` |
| RPC | `track_email_as_applied` | `EmailMonitoringPage.tsx` |
| Edge function | `gmail-sync` | `emailSync.ts` |

**Key files.** `EmailMonitoringPage.tsx`, `emailView.ts` (pure view rules),
`emailSync.ts`.

**Tests.** `emailsView.test.ts`, `emailsTrack.test.ts`, `emailsE2e.test.ts`,
`emailSync.test.ts`.

---

## `referral/` - Referral queue

**What the user does.** Reviews cold referral message drafts and marks one as sent.

**Route.** `/referrals`.

**Calls.** Table `application_events` only. It reads `note` events with
`detail->>action` `referral_outreach_drafted` and `referral_outreach_sent`, and
inserts a new event when the user marks a draft sent
(`ReferralOutreachPage.tsx:87-199`).

**Key files.** `ReferralOutreachPage.tsx`.

**Tests.** No dedicated test file at HEAD.

---

## `followup/` - Follow-up nudges

**What the user does.** Reviews day-7 follow-up email drafts that are `pending`
and updates each one.

**Route.** `/nudges`.

**Calls.** Table `follow_up_nudges` (read `status = 'pending'`; update one row)
(`FollowUpNudgesPage.tsx:70`, `:142`).

**Key files.** `FollowUpNudgesPage.tsx`.

**Tests.** No dedicated test file at HEAD.

---

## `analytics/` - Skill gap analytics

**What the user does.** Sees the missing technologies, ranked by how often jobs
ask for them.

**Route.** `/skill-gap`.

**Calls.** Table `skill_gap_reports` (read `skill_name`, `demand_count`)
(`SkillGapPage.tsx:89`).

**Key files.** `SkillGapPage.tsx`.

**Tests.** No dedicated test file at HEAD.

---

## `resume-preview/` - shared resume preview

**What the user does.** Sees the tailored resume and its master side by side,
each drawn by the same renderer the worker uses for the PDF, and downloads either.

**Route.** None. Used by the Approval queue, the Pipeline drawer, Applied jobs and
Manual apply.

**Calls.** Table `master_profiles` (the master the row was tailored against).

**Key files.** `ResumePreview.tsx` (iframes, so the template's own stylesheet is
isolated), `renderPreview.ts` (calls the worker renderer, see
`worker/src/render-resume-pdf.ts`; also names the download file).

**Tests.** `resumePreview.test.ts`, `resumePreviewZoom.test.ts`,
`resumePreviewPaneNames.test.ts`, `resumePreviewEntryLinks.test.ts`,
`resumePreviewDenseHint.test.ts`.

---

## `profile/` - PDF extraction helper

**What it does.** `pdfExtractor.ts` turns resume PDF bytes into a typed
`MasterProfile` in the browser, using `@applyy/master-pdf`. The PDF is never
uploaded before the user approves the result. `settings/pdfExtractor.ts` only
re-exports it.

**Route.** None. Used by the Master profile page.

**Calls.** None.

---

## `settings/` - the six Configuration pages

### Search preferences (`/search-preferences`)

**What the user does.** Sets target titles, skills, locations, employment types,
work arrangements and pay. Also holds the system controls: the kill switch
(`system_settings.system_enabled`), the daily cap
(`system_settings.max_applications_per_day`) and auto-apply on approve
(`system_settings.auto_apply_on_approve`, read by `dispatch-apply`, default off).

**Calls.** Tables `search_preferences`, `system_settings` (read and upsert).

**Key files.** `SearchPreferencesPage.tsx`.

**Tests.** `searchPreferencesAutoApply.test.ts`,
`searchPreferencesRemotePolicy.test.ts`.

### Master profile (`/master-profile`)

**What the user does.** Views the master resume as structured fields, adds a node
with "+ Add", uploads a PDF or pastes JSON, then reviews what would change before
accepting. Master versions are immutable: every change is stored as a new version
N+1, built on the newest stored master (`masterAdd.ts` header).

**Calls.** Table `master_profiles` (`masterStore.ts`).

**Key files.** `MasterProfilePage.tsx`, `MasterUploadReview.tsx`, `masterAdd.ts`,
`masterIngest.ts` (checks with `@applyy/master-ingest`), `masterReview.ts`,
`masterStore.ts`, `pdfExtractor.ts`.

**Tests.** `masterAdd.test.ts`, `masterIngest.test.ts`, `masterReview.test.ts`,
`masterStore.test.ts`.

### Answer bank (`/answer-bank`)

**What the user does.** Keeps reusable answers for application questions. Three
parts: the main table (with **Add question**), **Eligibility answers** (questions
the form filler answers only from rows the user saved), and **Unanswered
questions** (required questions the worker refused; answer each once). A DB
trigger sets `answer_bank.attested_by_human` to true for browser writes. After a
save, the store asks `dispatch-apply` for a kit-only rebuild.

**Calls.**

| Kind | Name | Where |
| --- | --- | --- |
| Table | `answer_bank` | `answerBankStore.ts` |
| Table | `unanswered_questions`, `applications` | `unansweredQuestionsView.ts` |
| Table | `master_profiles` (via `masterStore.ts`) | `EligibilityAnswers.tsx` |
| Edge function | `dispatch-apply` with `{ kit_only: true }` | `answerBankStore.ts` (`requestKitRebuild`) |

**Key files.** `AnswerBankPage.tsx`, `AddQuestionModal.tsx`,
`EligibilityAnswers.tsx`, `UnansweredQuestions.tsx`, `answerBankStore.ts`,
`answerBankView.ts`, `unansweredQuestionsView.ts`.

**Tests.** `answerBankStore.test.ts`, `answerBankView.test.ts`,
`eligibilityAnswers.test.ts`, `unansweredQuestionsView.test.ts`,
`storeReadErrorBlocksSave.test.ts` (also covers `filtersStore.ts`).

### Filters (`/filters`)

**What the user does.** Edits the pre-screen rules (the filter cascade). Nothing in
the cascade is hard-coded; `filter_rules` is a table and this page is its editor
(`FiltersPage.tsx` header). The screener applies the rules in
`supabase/functions/_shared/filter/cascade.ts`.

**Calls.** Table `filter_rules` (`filtersStore.ts`).

**Key files.** `FiltersPage.tsx`, `filtersStore.ts`.

**Tests.** `filtersStore.test.ts`, `filtersNotEnforced.test.ts`,
`experienceCeilingDefault.test.ts`.

### Company watchlist (`/watchlist`)

**What the user does.** Adds or removes company boards for the scout to poll. Each
row is one company on one ATS, named by its board token. **Suggestions** opens a
catalog of verified companies (`CompanySuggestionsModal.tsx`, `companyCatalog.ts`).
SmartRecruiters boards cannot be added (robots ruling, 2026-11-01).

**Calls.** Table `company_watchlist`.

**Key files.** `WatchlistPage.tsx`, `CompanySuggestionsModal.tsx`,
`companyCatalog.ts`.

**Tests.** `companyCatalog.test.ts`, `smartRecruitersNotAddable.test.ts`.

### Blocklist (`/blocklist`)

**What the user does.** Adds or removes companies and agencies to exclude.

**Calls.** Table `company_blocklist`.

**Key files.** `BlocklistPage.tsx`.

**Tests.** No dedicated test file at HEAD.

---

## Tests not tied to one feature

`apiContracts.test.ts` (web call shapes vs `src/data/contract.ts`),
`postscreenDrainManualOnly.test.ts` (`.github/workflows/postscreen-drain.yml`), `e2eSuite.test.ts` (Playwright
suite), `vercelIgnoreCommand.test.ts` (Vercel build skip rule),
`noEmoji.test.ts`, `noJsxCommentText.test.ts` (a `//` between JSX tags renders as
text). Fixtures live in `test/fixtures/`, helpers in `test/support/`.
