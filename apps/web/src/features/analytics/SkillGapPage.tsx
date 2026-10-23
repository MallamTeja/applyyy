// Import React and hooks for managing component state and side effects
import React, { useEffect, useState } from 'react';
// Import Supabase client to fetch data from the database
import { supabase } from '../../data/supabase';
// The shared page header, so this page gets the same h1 + lede every route has.
import { PageHeader } from '../../app/PageHeader.tsx';
// Import CSS for styling the analytics page
import './analytics.css';

// The columns this page reads, named exactly as skill_gap_reports defines them
// (20260918213000_phase3_tables_and_gap_fixes.sql:120). The old interface named
// `frequency` and `demand_tier`, neither of which exists, so the order-by errored and
// `.toLowerCase()` on undefined would have crashed the render.
interface SkillGapReport {
  // Primary key, used as the React list key.
  id: string;
  // The missing skill, e.g. 'Kubernetes'.
  skill_name: string;
  // How many matched/applied jobs asked for it — the only demand measure stored.
  demand_count: number;
}

// The badge vocabulary analytics.css already styles (.tier-high/.tier-medium/.tier-low).
type DemandTier = 'High' | 'Medium' | 'Low';

// Derive a tier in code, because the table stores only a count. Relative to the
// most-demanded skill so the badge reads as "compared with your other gaps".
// ponytail: thirds of the max; switch to absolute thresholds if counts get large.
export function demandTierFor(count: number, maxCount: number): DemandTier {
  // Guard divide-by-zero and garbage: no demand data is the lowest tier, not NaN.
  if (!(maxCount > 0) || !(count > 0)) return 'Low';
  // Share of the top skill's demand.
  const share = count / maxCount;
  // Top third of demand.
  if (share >= 2 / 3) return 'High';
  // Middle third.
  if (share >= 1 / 3) return 'Medium';
  // Everything else.
  return 'Low';
}

// Validate one row's SHAPE instead of trusting a cast: a renamed column must drop
// the row visibly, not render "undefined" or crash on a method call.
function toReport(row: unknown): SkillGapReport | null {
  // Anything that is not an object cannot be a row.
  if (typeof row !== 'object' || row === null) return null;
  // Index the unknown object without widening to any.
  const r = row as Record<string, unknown>;
  // All three fields must have the types the UI depends on.
  if (typeof r['id'] !== 'string' || typeof r['skill_name'] !== 'string' || typeof r['demand_count'] !== 'number') {
    // Reject rather than coerce: a missing count must not become 0 and look real.
    return null;
  }
  // Rebuild with only the known fields.
  return { id: r['id'], skill_name: r['skill_name'], demand_count: r['demand_count'] };
}

// Define the functional component for the Skill Gap Page
export const SkillGapPage: React.FC = () => {
  // State variable to hold the fetched skill gap reports
  const [reports, setReports] = useState<SkillGapReport[]>([]);
  // State variable to track loading status
  const [loading, setLoading] = useState<boolean>(true);
  // State variable to track any potential errors during fetch
  const [error, setError] = useState<string | null>(null);

  // useEffect hook to fetch data when the component mounts
  useEffect(() => {
    // Define an asynchronous function to perform the data fetch
    const fetchReports = async () => {
      // Set loading to true before starting the fetch
      setLoading(true);
      // Clear any previous errors
      setError(null);
      // Check if supabase is initialized
      if (!supabase) {
        // Update error state
        setError("Supabase client is not available.");
        // Set loading false
        setLoading(false);
        // Exit function
        return;
      }
      // Execute the query against the skill_gap_reports table
      const { data, error } = await supabase
        // The table the skill-gap Edge Function writes.
        .from('skill_gap_reports')
        // Only the columns rendered; `*` would hide a rename until runtime.
        .select('id, skill_name, demand_count')
        // Most-demanded first — `demand_count` is the real column; `frequency` never existed.
        .order('demand_count', { ascending: false });

      // If an error occurred during the query
      if (error) {
        // Update the error state with the error message
        setError(error.message);
      } else {
        // Keep only rows of the expected shape; null-safe on an empty answer.
        setReports((data ?? []).map(toReport).filter((r): r is SkillGapReport => r !== null));
      }
      // Set loading to false after the fetch completes
      setLoading(false);
    };

    // Invoke the fetch function
    void fetchReports();
  // Dependency array is empty so this runs only once on mount
  }, []);

  // If the component is still loading data
  if (loading) {
    // Render a loading indicator
    return <div className="skill-gap-loading">Loading skill gap data...</div>;
  }

  // If an error occurred during fetch
  if (error) {
    // Render the error message
    return <div className="skill-gap-error">Error: {error}</div>;
  }

  // Find the maximum demand to scale bar widths and tiers; floor at 1 avoids divide-by-zero.
  const maxDemand = Math.max(...reports.map((r) => r.demand_count), 1);

  // Render the main container for the skill gap page
  return (
    // Container div with standard class
    <div className="skill-gap-page">
      {/* The standard route header (an h1 .page__title): this was the one page whose
          title was a bare h2, so it rendered 18px while every sibling page leads at 24px
          — and the document had no h1 at all (fixed 2026-10-23). */}
      <PageHeader path="skill-gap" />
      {/* Empty is a real answer (no gaps recorded yet), stated rather than shown as a blank chart. */}
      {reports.length === 0 && <p className="skill-gap-loading">No skill gaps recorded yet.</p>}
      {/* Container for the horizontal bar chart */}
      <div className="skill-gap-chart">
        {/* One bar per missing skill, most-demanded first. */}
        {reports.map((report) => {
          // Derived once per row so the badge text and its class cannot disagree.
          const tier = demandTierFor(report.demand_count, maxDemand);
          // Render this skill's row.
          return (
            // Individual bar container, keyed by report ID
            <div key={report.id} className="skill-gap-bar-container">
              {/* Label section containing skill name and demand tier */}
              <div className="skill-gap-label">
                {/* Skill name text */}
                <span className="skill-name">{report.skill_name}</span>
                {/* Tier badge, derived from demand_count because no tier column exists. */}
                <span className={`demand-tier tier-${tier.toLowerCase()}`}>
                  {/* The derived tier word, paired with its colour for accessibility. */}
                  {tier}
                </span>
              </div>
              {/* The track the filled bar sits in */}
              <div className="skill-gap-bar-wrapper">
                {/* Width is demand relative to the most-demanded skill. */}
                <div
                  className="skill-gap-bar-fill"
                  style={{ width: `${(report.demand_count / maxDemand) * 100}%` }}
                >
                  {/* The exact count, so the bar is never the only signal. */}
                  <span className="frequency-count">{report.demand_count}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
