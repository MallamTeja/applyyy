// Import React and hooks for state and side effects
import React, { useEffect, useState } from 'react';
// Import Supabase client to fetch data
import { supabase } from '../../data/supabase';

// Interface defining the expected props for the component
interface InterviewPrepPanelProps {
  // Application ID passed as a string
  applicationId: string;
}

// The pack as this panel renders it, named after the REAL columns of
// interview_prep_packs (20260918213000_phase3_tables_and_gap_fixes.sql:149-168).
// The old interface read `role_questions` and `key_talking_points`, which do not
// exist, so `.map` ran on undefined and crashed the whole drawer.
interface InterviewPrepPack {
  // Free text; nullable in the schema, so the UI must allow its absence.
  company_overview: string | null;
  // jsonb array of predicted questions (column: role_specific_questions).
  role_specific_questions: string[];
  // jsonb array of the candidate's relevant experience.
  experience_highlights: string[];
  // jsonb array of things to mention (column: talking_points).
  talking_points: string[];
}

// The exact column list, shared by the query and the reader so they cannot drift apart.
const PACK_COLUMNS = 'company_overview, role_specific_questions, experience_highlights, talking_points';

// jsonb arrives as `unknown`; keep only strings, so a malformed element is dropped
// instead of rendering "[object Object]" or crashing on a non-array.
function toStringList(value: unknown): string[] {
  // Not an array (null, object, renamed column) reads as an empty list, never a crash.
  if (!Array.isArray(value)) return [];
  // Strings only; the generator's contract is string[] (parse-pack.ts:18-22).
  return value.filter((item): item is string => typeof item === 'string');
}

// Validate the row's shape rather than casting it.
export function toPrepPack(row: unknown): InterviewPrepPack | null {
  // A non-object is not a pack.
  if (typeof row !== 'object' || row === null) return null;
  // Index without widening to any.
  const r = row as Record<string, unknown>;
  // Assemble with every field normalised to the type the JSX relies on.
  return {
    // Only a real string counts as an overview.
    company_overview: typeof r['company_overview'] === 'string' ? r['company_overview'] : null,
    // Each list goes through the same defensive reader.
    role_specific_questions: toStringList(r['role_specific_questions']),
    // Same reader, same guarantees.
    experience_highlights: toStringList(r['experience_highlights']),
    // Same reader, same guarantees.
    talking_points: toStringList(r['talking_points']),
  };
}

// One titled list; shared so the three sections cannot diverge in their empty handling.
function PrepList({ title, items }: { readonly title: string; readonly items: readonly string[] }): React.ReactElement {
  // Render one section.
  return (
    <div className="prep-section">
      {/* Section header */}
      <h4>{title}</h4>
      {/* An empty array is stated, not rendered as a bare heading over nothing. */}
      {items.length === 0 ? (
        <p>None generated.</p>
      ) : (
        <ul>
          {/* Index keys are fine: the list is static for the life of the render. */}
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Define the functional component taking applicationId as a prop
export const InterviewPrepPanel: React.FC<InterviewPrepPanelProps> = ({ applicationId }) => {
  // State variable to store the fetched prep pack data
  const [prepData, setPrepData] = useState<InterviewPrepPack | null>(null);
  // State variable to manage loading status
  const [loading, setLoading] = useState<boolean>(true);
  // State variable to hold any error messages
  const [error, setError] = useState<string | null>(null);

  // useEffect hook to run side effects when applicationId changes
  useEffect(() => {
    // Ignore a response that lands after the drawer switched application or closed.
    let live = true;
    // Define an asynchronous function to fetch the prep data
    const fetchPrepData = async () => {
      // Set loading true before starting fetch
      setLoading(true);
      // Reset error state
      setError(null);
      // Clear the previous application's pack so it is never shown under this one.
      setPrepData(null);

      // Check if supabase is initialized
      if (!supabase) {
        // Update error state
        setError("Supabase client is not available.");
        // Set loading false
        setLoading(false);
        // Exit function
        return;
      }

      // Execute query against interview_prep_packs table
      const { data, error } = await supabase
        // Target table
        .from('interview_prep_packs')
        // Only the rendered columns, by their real names.
        .select(PACK_COLUMNS)
        // Filter by the provided application ID
        .eq('application_id', applicationId)
        // No UNIQUE on application_id, so a regenerated pack adds a row: take the newest.
        .order('generated_at', { ascending: false })
        // At most one row, so maybeSingle never sees "multiple rows".
        .limit(1)
        // Zero rows is "no pack yet", NOT an error — .single() reported it as PGRST116.
        .maybeSingle();

      // A stale response must not overwrite the current application's state.
      if (!live) return;
      // If an error occurred during fetch
      if (error) {
        // Update error state
        setError(error.message);
      } else {
        // null data stays null and renders the "none yet" message; a row is shape-checked.
        setPrepData(data === null ? null : toPrepPack(data));
      }
      // Set loading false after completion
      setLoading(false);
    };

    // If an applicationId is provided, trigger the fetch
    if (applicationId) {
      // Errors are handled in-function; void marks the promise as deliberately unawaited.
      void fetchPrepData();
    } else {
      // No id means nothing to load; without this the panel spun forever.
      setLoading(false);
    }
    // Cleanup flips the guard so a late response is ignored.
    return () => {
      // Mark this effect run as superseded.
      live = false;
    };
  // Include applicationId in dependency array
  }, [applicationId]);

  // Render loading state if data is being fetched
  if (loading) {
    // Simple loading text
    return <div>Loading interview prep materials...</div>;
  }

  // Render error state if an error occurred
  if (error) {
    // Display the error message
    return <div>Error loading prep materials: {error}</div>;
  }

  // Handle case where no data was found for the application
  if (!prepData) {
    // Inform user that no data is available
    return <div>No interview prep materials found for this application.</div>;
  }

  // Render the main panel content
  return (
    // Main container div
    <div className="interview-prep-panel">
      {/* Title of the panel */}
      <h3>Interview Preparation</h3>

      {/* Section for Company Overview */}
      <div className="prep-section">
        {/* Section header */}
        <h4>Company Overview</h4>
        {/* The column is nullable; say so rather than render an empty paragraph. */}
        <p>{prepData.company_overview ?? 'No overview generated.'}</p>
      </div>

      {/* Predicted questions, from role_specific_questions. */}
      <PrepList title="Role-Specific Questions" items={prepData.role_specific_questions} />
      {/* Relevant experience, from experience_highlights. */}
      <PrepList title="Experience Highlights" items={prepData.experience_highlights} />
      {/* Things to mention, from talking_points. */}
      <PrepList title="Key Talking Points" items={prepData.talking_points} />
    </div>
  );
};
