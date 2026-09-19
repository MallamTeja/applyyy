// Import React core library to define components and hooks
import React, { useEffect, useState } from 'react';
// Import the Supabase client creation utility
// This allows us to connect to the backend database
import { createClient } from '@supabase/supabase-js';
// Import the associated CSS file for styling
// Contains classes for cards, buttons, and layout
import './referral.css';

// Read the Supabase URL from environment variables
// This points to our specific project instance
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || '';
// Read the Supabase anonymous key from environment variables
// This is required for client-side authentication
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
// Initialize the Supabase client with the URL and key
// This client will be used for all database queries and function invocations
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Define an interface for the Referral Draft data structure
// This ensures type safety when handling draft data throughout the component
interface ReferralDraft {
    // Unique identifier for the application event record
    id: string;
    // Identifier for the associated job application
    applicationId: string;
    // Name of the company the application is for
    companyName: string;
    // Title of the job being applied to
    jobTitle: string;
    // Location of the job (e.g., city, state, or Remote)
    location: string;
    // The intended recipient's role (e.g., Peer Engineer, Hiring Manager)
    recipientRole: string;
    // The drafted subject line for the email or message
    subjectLine: string;
    // The main content/body of the outreach message
    messageBody: string;
    // AI-generated strategic notes for networking
    strategicNotes: string;
    // Boolean flag indicating if the outreach has been marked as sent
    sent: boolean;
}

// Define the main default export for the Referral Outreach Page
// This functional component renders the queue of drafted messages
export default function ReferralOutreachPage() {
    // Initialize state to hold the array of referral drafts
    // Defaults to an empty array before data is fetched
    const [drafts, setDrafts] = useState<ReferralDraft[]>([]);
    // Initialize state to track whether data is currently being loaded
    // Defaults to true so the loading indicator shows initially
    const [loading, setLoading] = useState<boolean>(true);

    // Use the useEffect hook to fetch data when the component mounts
    // The empty dependency array ensures this only runs once
    useEffect(() => {
        // Define an asynchronous function to perform the data fetching
        // This is necessary because useEffect callbacks cannot directly be async
        const fetchDrafts = async () => {
            // Set the loading state to true to show the loading indicator
            setLoading(true);
            
            // Query the application_events table using the Supabase client
            // We join with the applications and jobs tables to get company and job details
            const { data, error } = await supabase
                // Specify the root table to query
                .from('application_events')
                // Define the columns to select, including nested relations
                .select(`
                    id,
                    application_id,
                    detail,
                    applications (
                        jobs (
                            company_name,
                            title,
                            location
                        )
                    )
                `)
                // Filter the results to only include events of type 'note'
                .eq('event_type', 'note')
                // Further filter to only include events where the action is 'referral_outreach_drafted'
                // We use the JSON arrow operator to query inside the detail column
                .eq('detail->>action', 'referral_outreach_drafted');

            // Check if the query returned an error
            if (error) {
                // Log the error to the console for debugging purposes
                console.error("Error fetching drafts:", error);
            } else if (data) {
                // If data was returned successfully, map it to our TypeScript interface
                // We map over the array of raw database records
                const mappedDrafts: ReferralDraft[] = data.map((item: any) => ({
                    // Assign the event ID
                    id: item.id,
                    // Assign the associated application ID
                    applicationId: item.application_id,
                    // Extract the company name, providing a fallback if missing
                    companyName: item.applications?.jobs?.company_name || 'Unknown Company',
                    // Extract the job title, providing a fallback if missing
                    jobTitle: item.applications?.jobs?.title || 'Unknown Title',
                    // Extract the job location, providing a fallback if missing
                    location: item.applications?.jobs?.location || 'Remote',
                    // Extract the recipient role from the JSON detail object
                    recipientRole: item.detail?.recipientRole || 'Peer Engineer',
                    // Extract the subject line from the JSON detail object
                    subjectLine: item.detail?.subjectLine || '',
                    // Extract the message body from the JSON detail object
                    messageBody: item.detail?.messageBody || '',
                    // Extract the strategic notes from the JSON detail object
                    strategicNotes: item.detail?.strategicNotes || '',
                    // Initialize the sent status to false for all fetched drafts
                    // This could theoretically be computed by checking for 'referral_outreach_sent' events
                    sent: false
                }));
                // Update the component state with the newly mapped drafts array
                setDrafts(mappedDrafts);
            }
            // Once fetching and mapping is complete (or if an error occurred), set loading to false
            setLoading(false);
        };
        
        // Invoke the asynchronous fetch function we just defined
        fetchDrafts();
    }, []); // The empty array ensures this effect runs exactly once on mount

    // Define a handler function to copy the message to the clipboard
    // It accepts the specific draft object as a parameter
    const handleCopy = (draft: ReferralDraft) => {
        // Construct the full text block to be copied
        // It includes the subject line and message body separated by blank lines
        const textToCopy = `Subject: ${draft.subjectLine}\n\n${draft.messageBody}`;
        
        // Use the browser's clipboard API to write the text
        navigator.clipboard.writeText(textToCopy)
            .then(() => {
                // On successful copy, alert the user so they know it worked
                alert("Copied to clipboard!");
            })
            .catch(err => {
                // On failure, log the error to the console
                console.error("Failed to copy text: ", err);
            });
    };

    // Define a handler function to open a LinkedIn search for company alumni
    // It accepts the company name as a parameter
    const handleLinkedInSearch = (companyName: string) => {
        // Construct the search query string by appending 'alumni engineering' to the company name
        const searchQuery = `${companyName} alumni engineering`;
        // URL-encode the search query so it can be safely included in the URL
        const encodedQuery = encodeURIComponent(searchQuery);
        // Construct the full LinkedIn search URL
        const url = `https://www.linkedin.com/search/results/people/?keywords=${encodedQuery}`;
        // Open the constructed URL in a new browser tab or window
        window.open(url, '_blank');
    };

    // Define an asynchronous handler function to mark a draft as sent
    // It accepts the event ID and application ID as parameters
    const handleMarkAsSent = async (draftId: string, applicationId: string) => {
        // Perform an insert operation on the application_events table
        // This records the action so the backend knows the outreach was sent
        const { error } = await supabase
            // Target the correct table
            .from('application_events')
            // Insert a new record
            .insert({
                // Link the event to the correct application
                application_id: applicationId,
                // Categorize the event as a 'note'
                event_type: 'note',
                // Store the specific action in the JSON detail column
                detail: { action: 'referral_outreach_sent' }
            });
            
        // Check if the database insert failed
        if (error) {
            // Log the error to the console for debugging
            console.error("Error marking as sent:", error);
            // Optionally notify the user (omitted here for brevity, but a toast would be good)
        } else {
            // If the insert succeeded, update the local component state
            // This prevents needing to re-fetch all drafts from the server
            setDrafts(prevDrafts => 
                // Map over the previous drafts array
                prevDrafts.map(d => 
                    // If the current draft ID matches the one we marked as sent
                    // Return a new object with the sent flag flipped to true
                    // Otherwise, return the original draft object unchanged
                    d.id === draftId ? { ...d, sent: true } : d
                )
            );
        }
    };

    // Define an asynchronous handler function to regenerate a draft via an Edge Function
    // It accepts the application ID as a parameter
    const handleRegenerate = async (applicationId: string) => {
        // Invoke the 'referral' Edge Function using the Supabase client
        // Pass the application ID in the request body
        const { error } = await supabase.functions.invoke('referral', {
            // Provide the required body payload
            body: { applicationId }
        });
        
        // Check if the Edge Function invocation failed
        if (error) {
            // Log the error for debugging
            console.error("Error regenerating draft:", error);
            // Alert the user that the operation failed
            alert("Failed to regenerate draft.");
        } else {
            // If successful, alert the user that the process has started
            // It runs asynchronously, so they will need to refresh the page later
            alert("Draft regeneration triggered. Please refresh the page soon to see updates.");
        }
    };

    // Conditional rendering for the loading state
    // If the data is still being fetched, show a simple loading message
    if (loading) {
        // Return a basic div with loading text
        return <div>Loading outreach drafts...</div>;
    }

    // Main render return statement
    // Returns the JSX for the complete page structure
    return (
        // The outermost container div for the page
        // Applies the 'referral-container' CSS class for layout and max-width
        <div className="referral-container">
            
            {/* The main heading for the page */}
            <h1>Referral Outreach Queue</h1>
            
            {/* Iterate over the drafts array to render a card for each one */}
            {/* We use the map function to transform data objects into JSX elements */}
            {drafts.map((draft) => (
                // The container div for a single referral card
                // Requires a unique 'key' prop for React's reconciliation algorithm
                // Applies the 'referral-card' CSS class for styling borders and shadows
                <div key={draft.id} className="referral-card">
                    
                    {/* The header section of the card */}
                    {/* Contains the job info and the recipient badge */}
                    <div className="card-header">
                        
                        {/* A wrapper div for the title and company name */}
                        {/* Groups them together on the left side of the flexbox */}
                        <div>
                            
                            {/* The job title heading */}
                            {/* Applies the 'job-title' CSS class for typography styling */}
                            <h2 className="job-title">
                                {/* Display the job title text */}
                                {draft.jobTitle}
                                
                                {/* A span element for the location pill */}
                                {/* Positioned inline next to the job title */}
                                <span className="location-pill">
                                    {/* Display the location text */}
                                    {draft.location}
                                </span>
                            </h2>
                            
                            {/* The company name paragraph */}
                            {/* Positioned below the job title */}
                            <p className="company-name">
                                {/* Display the company name text */}
                                {draft.companyName}
                            </p>
                            
                        </div>
                        
                        {/* The badge element displaying the target recipient role */}
                        {/* Positioned on the right side of the flexbox container */}
                        <div className="badge">
                            {/* Display the recipient role text */}
                            {draft.recipientRole}
                        </div>
                        
                    </div>

                    {/* The input group for the Subject Line */}
                    {/* Wraps the label and input to provide consistent vertical spacing */}
                    <div className="input-group">
                        
                        {/* The label for the subject line input */}
                        <label className="label">Subject Line</label>
                        
                        {/* The text input displaying the subject line */}
                        <input 
                            // Set the input type to standard text
                            type="text" 
                            // Make the input read-only since this is just a viewer queue
                            readOnly 
                            // Bind the value to the draft's subject line data
                            value={draft.subjectLine} 
                            // Apply the common input field styling class
                            className="input-field" 
                        />
                        
                    </div>

                    {/* The input group for the Message Body */}
                    {/* Wraps the label and textarea to provide consistent vertical spacing */}
                    <div className="input-group">
                        
                        {/* The label for the message body textarea */}
                        <label className="label">Message Body</label>
                        
                        {/* The textarea displaying the multi-line message body */}
                        <textarea 
                            // Make the textarea read-only since this is just a viewer queue
                            readOnly 
                            // Bind the value to the draft's message body data
                            value={draft.messageBody} 
                            // Apply the common input field styling class
                            className="input-field" 
                            // Set a default vertical size of 6 rows
                            rows={6}
                        />
                        
                    </div>

                    {/* The input group for the Strategic Networking Notes */}
                    {/* Wraps the label and textarea to provide consistent vertical spacing */}
                    <div className="input-group">
                        
                        {/* The label for the strategic notes textarea */}
                        <label className="label">Strategic Networking Notes</label>
                        
                        {/* The textarea displaying the multi-line strategic notes */}
                        <textarea 
                            // Make the textarea read-only since this is just a viewer queue
                            readOnly 
                            // Bind the value to the draft's strategic notes data
                            value={draft.strategicNotes} 
                            // Apply the common input field styling class
                            className="input-field" 
                            // Set a default vertical size of 3 rows since notes are usually shorter
                            rows={3}
                        />
                        
                    </div>

                    {/* The container for the action buttons at the bottom of the card */}
                    {/* Uses flexbox to lay out buttons in a row with wrapping */}
                    <div className="actions">
                        
                        {/* The button to copy the message contents to the clipboard */}
                        <button 
                            // Attach the click event handler
                            // Uses an inline arrow function to pass the current draft
                            onClick={() => handleCopy(draft)} 
                            // Apply the base button class and the secondary styling variant
                            className="btn btn-secondary"
                        >
                            {/* Button text with an emoji icon */}
                            📋 Copy Message
                        </button>
                        
                        {/* The button to open a LinkedIn search for alumni */}
                        <button 
                            // Attach the click event handler
                            // Uses an inline arrow function to pass the company name
                            onClick={() => handleLinkedInSearch(draft.companyName)} 
                            // Apply the base button class and the link styling variant
                            className="btn btn-link"
                        >
                            {/* Button text with an emoji icon */}
                            🔗 Search Alumni on LinkedIn
                        </button>
                        
                        {/* The primary button to mark the draft as sent */}
                        <button 
                            // Attach the click event handler
                            // Uses an inline arrow function to pass the draft and app IDs
                            onClick={() => handleMarkAsSent(draft.id, draft.applicationId)} 
                            // Dynamically apply classes based on the sent state
                            // If sent, apply secondary styling; if not, apply primary styling
                            className={`btn ${draft.sent ? 'btn-secondary' : 'btn-primary'}`}
                            // Disable the button if the draft has already been marked as sent
                            disabled={draft.sent}
                        >
                            {/* Dynamically display text based on the sent state */}
                            {draft.sent ? '✅ Sent' : '✅ Mark as Sent'}
                        </button>
                        
                        {/* The button to trigger regeneration of the draft via the edge function */}
                        <button 
                            // Attach the click event handler
                            // Uses an inline arrow function to pass the application ID
                            onClick={() => handleRegenerate(draft.applicationId)} 
                            // Apply the base button class and the secondary styling variant
                            className="btn btn-secondary"
                        >
                            {/* Button text with an emoji icon */}
                            🔄 Regenerate Draft
                        </button>
                        
                    </div>
                    
                </div>
            ))}
            
            {/* Conditional rendering for the empty state */}
            {/* If there are no drafts in the queue, display a friendly message */}
            {drafts.length === 0 && (
                // Render a paragraph explaining that the queue is empty
                <p>No referral drafts in the queue.</p>
            )}
            
        </div>
    );
}
