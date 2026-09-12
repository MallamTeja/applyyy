import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyDiscoveryTier,
  parseLinkedInHiringPost,
  buildTier2LinkedInPostJob,
  buildTier3AggregatorJob,
  type LinkedInPostInput,
  type AggregatorJobInput,
} from "./tiers.ts";

test("classifyDiscoveryTier — Tier 1: Direct Career Pages", () => {
  // Direct career page enum
  const t1A = classifyDiscoveryTier("company_career_page", null, "greenhouse");
  assert.equal(t1A.tier, 1);
  assert.equal(t1A.pillTheme, "career-page");
  assert.equal(t1A.badgeLabel, "🏢 Career Page · Greenhouse");

  // Lever direct board
  const t1B = classifyDiscoveryTier("lever", null, "lever");
  assert.equal(t1B.tier, 1);
  assert.equal(t1B.pillTheme, "career-page");
  assert.equal(t1B.badgeLabel, "🏢 Career Page · Lever");

  // Ashby direct board
  const t1C = classifyDiscoveryTier("ashby", null, "ashby");
  assert.equal(t1C.tier, 1);
  assert.equal(t1C.pillTheme, "career-page");
  assert.equal(t1C.badgeLabel, "🏢 Career Page · Ashby");
});

test("classifyDiscoveryTier — Tier 2: LinkedIn Posts & Feeds", () => {
  // Tagged with linkedin_post
  const t2A = classifyDiscoveryTier("linkedin_post", {
    url: "https://www.linkedin.com/feed/update/urn:li:activity:7123456789",
    metadata: { type: "post", author: "Sarah (Founder)" },
  });
  assert.equal(t2A.tier, 2);
  assert.equal(t2A.canonicalSource, "linkedin_post");
  assert.equal(t2A.pillTheme, "linkedin-post");
  assert.equal(t2A.badgeLabel, "💬 LinkedIn Post (Sarah (Founder))");

  // Tagged with linkedin and metadata { type: 'post' }
  const t2B = classifyDiscoveryTier("linkedin", {
    url: "https://www.linkedin.com/posts/acme_hiring-activity-12345",
    metadata: { type: "post" },
  });
  assert.equal(t2B.tier, 2);
  assert.equal(t2B.pillTheme, "linkedin-post");
  assert.equal(t2B.badgeLabel, "💬 LinkedIn Post (Hiring Lead)");

  // Detected via LinkedIn feed URL in sourceRef
  const t2C = classifyDiscoveryTier("linkedin", {
    url: "https://www.linkedin.com/feed/update/urn:li:activity:99999",
  });
  assert.equal(t2C.tier, 2);
  assert.equal(t2C.pillTheme, "linkedin-post");
});

test("classifyDiscoveryTier — Tier 3: Portals & Aggregators", () => {
  // Naukri
  const t3Naukri = classifyDiscoveryTier("naukri");
  assert.equal(t3Naukri.tier, 3);
  assert.equal(t3Naukri.pillTheme, "portal");
  assert.equal(t3Naukri.badgeLabel, "🌐 Portal · Naukri");

  // LinkedIn Job Portal (not a post)
  const t3LinkedIn = classifyDiscoveryTier("linkedin", {
    url: "https://www.linkedin.com/jobs/view/123456789",
  });
  assert.equal(t3LinkedIn.tier, 3);
  assert.equal(t3LinkedIn.pillTheme, "portal");
  assert.equal(t3LinkedIn.badgeLabel, "🌐 LinkedIn Jobs");

  // Adzuna
  const t3Adzuna = classifyDiscoveryTier("adzuna");
  assert.equal(t3Adzuna.tier, 3);
  assert.equal(t3Adzuna.badgeLabel, "🌐 Portal · Adzuna");

  // Jooble
  const t3Jooble = classifyDiscoveryTier("jooble");
  assert.equal(t3Jooble.tier, 3);
  assert.equal(t3Jooble.badgeLabel, "🌐 Portal · Jooble");
});

test("parseLinkedInHiringPost — extracts hiring post fields correctly", () => {
  const post: LinkedInPostInput = {
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:789123",
    authorName: "Kunal Shah",
    authorRole: "founder",
    postText: "We're hiring a Senior Frontend Engineer at CRED in Bengaluru, India! Remote friendly. Apply here: https://jobs.ashbyhq.com/cred/frontend-123 or DM me.",
  };

  const parsed = parseLinkedInHiringPost(post);
  assert.match(parsed.title, /Frontend Engineer/i);
  assert.equal(parsed.companyName, "CRED");
  assert.equal(parsed.companySlug, "cred");
  assert.equal(parsed.applyUrl, "https://jobs.ashbyhq.com/cred/frontend-123");
  assert.equal(parsed.workArrangement, "remote");
  assert.equal(parsed.authorName, "Kunal Shah");
});

test("buildTier2LinkedInPostJob — tags provenance into discovered_via and source_refs", async () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  const post = parseLinkedInHiringPost({
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:789123",
    authorName: "Deepinder",
    postText: "We are hiring a Full Stack Intern at Zomato! Remote friendly. Apply: https://apply.zomato.com/intern",
  });

  const row = await buildTier2LinkedInPostJob(post, { now, firstSeenAt: now });
  assert.deepEqual(row.discovered_via, ["linkedin_post"]);
  assert.equal(row.source_refs.length, 1);
  assert.equal(row.source_refs[0]?.provider, "linkedin_post");
  assert.equal(row.source_refs[0]?.metadata?.tier, 2);
  assert.equal(row.source_refs[0]?.metadata?.type, "post");
  assert.equal(row.source_refs[0]?.metadata?.author, "Deepinder");
  assert.equal(row.posted_at_source, "exact");
});

test("buildTier3AggregatorJob — tags aggregator portal provenance", async () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  const input: AggregatorJobInput = {
    portal: "naukri",
    title: "React Developer",
    companyName: "Infosys",
    applyUrl: "https://www.naukri.com/job-listings-12345",
    portalJobId: "NK-998877",
    locationRaw: "Bangalore",
    workArrangement: "hybrid",
  };

  const row = await buildTier3AggregatorJob(input, { now, firstSeenAt: now });
  assert.deepEqual(row.discovered_via, ["naukri"]);
  assert.equal(row.source_refs.length, 1);
  assert.equal(row.source_refs[0]?.provider, "naukri");
  assert.equal(row.source_refs[0]?.metadata?.tier, 3);
  assert.equal(row.source_refs[0]?.metadata?.portal, "naukri");
  assert.equal(row.ats_job_id, "NK-998877");
});
