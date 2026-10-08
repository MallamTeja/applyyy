# Harvest docs

Records of external codebases examined for reuse, and the decisions taken from them.

One file per topic, date-prefixed and named for its source; implementation briefs live in `briefs/`. A harvest source lives in
`reference/<repo>/` on disk and is **gitignored** — read from, never vendored.

| Doc | Topic |
|-----|-------|
| [2026-09-16-ai-job-search-inventory.md](2026-09-16-ai-job-search-inventory.md) | **What is in `MadsLorentzen/ai-job-search`.** Per-file verdicts across 6 portal adapters, 11 Python tools, 13 prompt skills and 12 command specs — plus what upstream does *not* have that we already do, recorded so a future session does not "harvest" a downgrade |
| [2026-09-16-ai-job-search-harvest-plan.md](2026-09-16-ai-job-search-harvest-plan.md) | **What to do about it.** Eight write-partitioned parcels ordered by value ÷ cost, the recommended first move, and three open questions that need a ruling rather than an assumption |

## Sources

| Source | Pinned at | Licence | Local path |
|---|---|---|---|
| [`MadsLorentzen/ai-job-search`](https://github.com/MadsLorentzen/ai-job-search) | `968fb1bd` (2026-09-16) | MIT, © 2026 Mads Lorentzen | `reference/ai-job-search-upstream/` |

**Attribution rule:** anything ported carries a header naming the upstream file and
commit. MIT requires the copyright and permission notices be retained; a header also
tells the next reader where to look when upstream fixes a bug we inherited.
