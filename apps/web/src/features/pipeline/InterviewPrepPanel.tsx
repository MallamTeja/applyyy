// Import React and hooks for state and side effects
import React, { useEffect, useState } from 'react';
// Import Supabase client to fetch data
import { supabase } from '../../data/supabase';

// Interface defining the expected props for the component
interface InterviewPrepPanelProps {
  // Application ID passed as a string
  applicationId: string;
}

// Interface defining the structure of an interview prep pack record
interface InterviewPrepPack {
  // Unique identifier for the prep pack
  id: string;
  // The application ID this pack belongs to
  application_id: string;
  // Overview of the company
  company_overview: string;
  // Array of role-specific interview questions
  role_questions: string[];
  // Array of the candidate's experience highlights relevant to the role
  experience_highlights: string[];
  // Array of key talking points for the interview
  key_talking_points: string[];
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
    // Define an asynchronous function to fetch the prep data
    const fetchPrepData = async () => {
      // Set loading true before starting fetch
      setLoading(true);
      // Reset error state
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

      // Execute query against interview_prep_packs table
      const { data, error } = await supabase
        // Target table
        .from('interview_prep_packs')
        // Select all columns
        .select('*')
        // Filter by the provided application ID
        .eq('application_id', applicationId)
        // Expect a single record
        .single();

      // If an error occurred during fetch
      if (error) {
        // Update error state
        setError(error.message);
      } else {
        // If successful, update state with retrieved data
        setPrepData(data as InterviewPrepPack);
      }
      // Set loading false after completion
      setLoading(false);
    };

    // If an applicationId is provided, trigger the fetch
    if (applicationId) {
      // Call the fetch function
      fetchPrepData();
    }
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
      // Title of the panel
      <h3>Interview Preparation</h3>

      // Section for Company Overview
      <div className="prep-section">
        // Section header
        <h4>Company Overview</h4>
        // Render the company overview text
        <p>{prepData.company_overview}</p>
      </div>

      // Section for Role-Specific Questions
      <div className="prep-section">
        // Section header
        <h4>Role-Specific Questions</h4>
        // Render list of questions
        <ul>
          // Map over each question
          {prepData.role_questions.map((question, index) => (
            // Render list item with a key
            <li key={index}>{question}</li>
          ))}
        </ul>
      </div>

      // Section for Experience Highlights
      <div className="prep-section">
        // Section header
        <h4>Experience Highlights</h4>
        // Render list of highlights
        <ul>
          // Map over each highlight
          {prepData.experience_highlights.map((highlight, index) => (
            // Render list item with a key
            <li key={index}>{highlight}</li>
          ))}
        </ul>
      </div>

      // Section for Key Talking Points
      <div className="prep-section">
        // Section header
        <h4>Key Talking Points</h4>
        // Render list of talking points
        <ul>
          // Map over each point
          {prepData.key_talking_points.map((point, index) => (
            // Render list item with a key
            <li key={index}>{point}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};
