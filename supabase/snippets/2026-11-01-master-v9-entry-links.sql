-- =============================================================================
-- Master profile v9: move three credential/profile links onto their owners
-- (2026-11-01).
--
-- WHY THIS EXISTS: master v8 (inserted 2026-11-01 09:41:48 UTC, content_hash
-- 495786a2...) parks three URLs in the top-level `profile.links` array, which no
-- renderer reads, so they never reach a resume. The contract change that ships
-- with this file adds `links?: DocumentOrdered<MasterLink>` to MasterCertification
-- and MasterAchievement, and the renderer prints those as clickable anchors. This
-- moves each link onto the node it proves; each link id already names its owner:
--   link_cert_prompt_eng -> certifications[id=cert_prompt_eng]
--   link_cert_ibm_ml     -> certifications[id=cert_ibm_ml]
--   link_leetcode        -> achievements[id=ach_leetcode]
--
-- KEEPS EVERY v8 ID. master_profiles is append-only and applications pin old
-- versions by id, so nothing is re-minted: the three links keep their ids and
-- move; every other node is copied byte-for-byte. Only the three owners gain a
-- `links` key; other certs/achievements stay key-absent (the contract's optional
-- field means absent = no links).
--
-- NO PERSONAL DATA IN THIS FILE: the profile is transformed inside the database
-- from the v8 row, which is anchored by its content_hash, so no name, email or
-- phone is written into the repo. version and content_hash are assigned by the
-- BEFORE INSERT triggers, never by this statement.
--
-- HOW TO RUN (orchestrator only - live write, CLAUDE.md section 2):
--   1. PREVIEW, read-only: run this file as it is. It is a plain SELECT and
--      writes nothing. Expect EXACTLY 1 row. 0 rows = a guard failed (see the
--      WHERE clause); stop. Then run the verifier, which re-runs this preview and
--      checks every v8 id survives, nothing else changed, and the three anchors
--      render:
--        node supabase/snippets/2026-11-01-master-v9-entry-links.verify.ts
--   2. APPLY: uncomment the TWO lines marked APPLY (the insert line and the
--      returning line) and run it once via `-f` (it starts with a comment).
--      Expect 1 row back with version 9. 0 rows = a guard failed and NOTHING was
--      written. Running it a second time writes nothing either: v8 is no longer
--      the latest, so the latest-version guard fails (and an identical profile
--      would also hit UNIQUE (user_id, content_hash)).
-- =============================================================================

-- APPLY: insert into public.master_profiles (user_id, profile, label)
with
  -- The v8 row, by its content hash (unique per user), so no user id is hardcoded.
  v8 as (
    select mp.user_id, mp.version, mp.profile
    from public.master_profiles mp
    where mp.content_hash = '495786a21d886b7d62489fecf72a4fca5062d8332770a9425e2de6bd987d8fe7'
  ),
  -- The three moves: which top-level link goes under which owner node.
  moves(link_id, section, owner_id) as (
    values
      ('link_cert_prompt_eng', 'certifications', 'cert_prompt_eng'),
      ('link_cert_ibm_ml',     'certifications', 'cert_ibm_ml'),
      ('link_leetcode',        'achievements',   'ach_leetcode')
  ),
  -- v8's top-level links with their positions, so order survives the move.
  top_links as (
    select t.link, t.ord
    from v8, jsonb_array_elements(v8.profile -> 'links') with ordinality as t(link, ord)
  ),
  -- Each owner's incoming links, in their original top-level order.
  moved as (
    select m.section, m.owner_id, jsonb_agg(t.link order by t.ord) as links
    from moves m
    join top_links t on t.link ->> 'id' = m.link_id
    group by m.section, m.owner_id
  ),
  -- Certifications with the moved links appended to their owners (other certs untouched).
  certs as (
    select coalesce(jsonb_agg(
      case when mv.links is null then c.node
           else c.node || jsonb_build_object('links', coalesce(c.node -> 'links', '[]'::jsonb) || mv.links)
      end order by c.ord), '[]'::jsonb) as arr
    from v8, jsonb_array_elements(v8.profile -> 'certifications') with ordinality as c(node, ord)
    left join moved mv on mv.section = 'certifications' and mv.owner_id = c.node ->> 'id'
  ),
  -- Achievements, same rule.
  achs as (
    select coalesce(jsonb_agg(
      case when mv.links is null then a.node
           else a.node || jsonb_build_object('links', coalesce(a.node -> 'links', '[]'::jsonb) || mv.links)
      end order by a.ord), '[]'::jsonb) as arr
    from v8, jsonb_array_elements(v8.profile -> 'achievements') with ordinality as a(node, ord)
    left join moved mv on mv.section = 'achievements' and mv.owner_id = a.node ->> 'id'
  ),
  -- The top-level links minus the three that moved, order preserved.
  kept as (
    select coalesce(jsonb_agg(t.link order by t.ord), '[]'::jsonb) as arr
    from top_links t
    where t.link ->> 'id' not in (select link_id from moves)
  )
select
  v8.user_id,
  -- Only these three keys change; every other key is v8's, byte for byte.
  v8.profile || jsonb_build_object('certifications', certs.arr, 'achievements', achs.arr, 'links', kept.arr) as profile,
  'v9: credential and profile links moved onto their certifications and achievement' as label
from v8, certs, achs, kept
where
  -- GUARD 1: v8 is still the LATEST version - nobody saved over it since.
  v8.version = (select max(mp.version) from public.master_profiles mp where mp.user_id = v8.user_id)
  -- GUARD 2: each of the three link ids is in v8's top-level links EXACTLY once.
  and (select count(*) from top_links t join moves m on t.link ->> 'id' = m.link_id) = 3
  and (select count(distinct t.link ->> 'id') from top_links t join moves m on t.link ->> 'id' = m.link_id) = 3
  -- GUARD 3: each owner exists exactly once, so no link is dropped or doubled.
  and (select count(*) from v8 v, jsonb_array_elements(v.profile -> 'certifications') c(node)
       where c.node ->> 'id' in ('cert_prompt_eng', 'cert_ibm_ml')) = 2
  and (select count(*) from v8 v, jsonb_array_elements(v.profile -> 'achievements') a(node)
       where a.node ->> 'id' = 'ach_leetcode') = 1
-- APPLY: returning user_id, version, content_hash, created_at
;
