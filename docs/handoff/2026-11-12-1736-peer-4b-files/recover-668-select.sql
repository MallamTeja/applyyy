-- The Workday rows the title-only tech gate dropped as unclassified with no body (2026-11-12 recovery input).
select a.id application_id, j.id job_id, j.title, j.apply_url
from applications a join jobs j on j.id = a.job_id
where j.ats_provider = 'workday' and a.status = 'dropped_filter' and a.drop_reason::text = 'tech_gate_unclassified'
  and (j.description_raw is null or btrim(j.description_raw) = '') and a.created_at > now() - interval '3 days'
order by a.created_at desc
