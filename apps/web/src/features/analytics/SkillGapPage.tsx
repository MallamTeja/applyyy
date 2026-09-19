// Import React and hooks for managing component state and side effects
import React, { useEffect, useState } from 'react';
// Import Supabase client to fetch data from the database
import { supabase } from '../../data/supabase';
// Import CSS for styling the analytics page
import './analytics.css';

// Define the interface for the skill gap report record
interface SkillGapReport {
  // Unique identifier for the skill gap record
  id: string;
  // The name of the missing skill identified
  skill_name: string;
  // The frequency count of how often this skill was missing
  frequency: number;
  // The demand tier, e.g., 'High', 'Medium', 'Low'
  demand_tier: string;
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
        // Select all columns from the table
        .from('skill_gap_reports')
        .select('*')
        // Order the results by frequency in descending order
        .order('frequency', { ascending: false });

      // If an error occurred during the query
      if (error) {
        // Update the error state with the error message
        setError(error.message);
      } else {
        // If successful, update the reports state with the data
        setReports(data || []);
      }
      // Set loading to false after the fetch completes
      setLoading(false);
    };

    // Invoke the fetch function
    fetchReports();
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

  // Find the maximum frequency to calculate chart bar widths
  const maxFrequency = Math.max(...reports.map(r => r.frequency), 1);

  // Render the main container for the skill gap page
  return (
    // Container div with standard class
    <div className="skill-gap-page">
      // Page title
      <h2>Skill Gap Analysis</h2>
      // Container for the horizontal bar chart
      <div className="skill-gap-chart">
        // Map over each report to render a bar
        {reports.map((report) => (
          // Individual bar container, keyed by report ID
          <div key={report.id} className="skill-gap-bar-container">
            // Label section containing skill name and demand tier
            <div className="skill-gap-label">
              // Skill name text
              <span className="skill-name">{report.skill_name}</span>
              // Demand tier indicator badge
              <span className={`demand-tier tier-${report.demand_tier.toLowerCase()}`}>
                // Render the demand tier text
                {report.demand_tier}
              </span>
            </div>
            // The actual bar representing the frequency
            <div className="skill-gap-bar-wrapper">
              // The filled portion of the bar
              <div 
                // Assign a CSS class for styling
                className="skill-gap-bar-fill"
                // Inline style to set width based on frequency relative to max
                style={{ width: `${(report.frequency / maxFrequency) * 100}%` }}
              >
                // Display the exact frequency number inside the bar
                <span className="frequency-count">{report.frequency}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
