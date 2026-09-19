// Import the standard web server function from Deno
// We will use Deno.serve to handle incoming HTTP requests
// Import the database client factory
// This gives us access to Supabase with the correct permissions
import { createAppUserClient } from "../_shared/db/client.ts";

// Import CORS headers for browser compatibility
// This is required for requests coming from the web dashboard
export const corsHeaders = {
  // Allow all origins for now
  "Access-Control-Allow-Origin": "*",
  // Allow specific authorization and content headers
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Import the nudge generation logic
// This shared module handles creating the prompt and calling Gemini
import { generateFollowUpNudge } from "../_shared/follow-up/nudge.ts";

// Start the Edge Function HTTP server
// Deno.serve automatically listens for requests
Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  // Browsers send OPTIONS requests before POST/GET requests
  if (req.method === "OPTIONS") {
    // Return a 204 No Content response
    // Include the standard CORS headers
    return new Response("ok", { headers: corsHeaders });
  }

  // Create a new database client connection
  // This uses the createAppUserClient helper
  const connection = await createAppUserClient();
  
  // Check if the database connection was successfully established
  // If not, we cannot proceed with the operation
  if (!connection.ok) {
    // Return a 503 Service Unavailable response
    // Include the error message and CORS headers
    return new Response(JSON.stringify({ error: "database_unavailable" }), {
      // Set status code 503
      status: 503,
      // Set headers indicating JSON content
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Extract the database client instance
  // We will use this to query and mutate data
  const db = connection.db;

  // Attempt to read the system settings from the database
  // This helps us implement a kill switch
  const { data: settingsData, error: settingsError } = await db
    // Query the system_settings table
    .from("system_settings")
    // Select the system_enabled flag
    .select("system_enabled")
    // Get a single row
    .single();

  // If there was an error reading settings, or the system is disabled
  // We abort the operation to respect the kill switch
  if (settingsError || !settingsData?.system_enabled) {
    // Return a 403 Forbidden response
    // This indicates the system is currently disabled
    return new Response(JSON.stringify({ error: "system_disabled" }), {
      // Set status code 403
      status: 403,
      // Set headers indicating JSON content
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Create a unique identifier for this agent run
  // We use the crypto API to generate a random UUID
  const runId = crypto.randomUUID();

  // Insert a record into the agent_runs telemetry table
  // This tracks the start of our follow-up generation job
  await db.from("agent_runs").insert({
    // Store the generated run ID
    id: runId,
    // Specify the agent name
    agent_name: "follow_up_nudge_agent",
    // Set the initial status to running
    status: "running",
  });

  // Wrap the main logic in a try-catch-finally block
  // This ensures we always update the agent_run status
  try {
    // Calculate the date 7 days ago
    // We only want to follow up on applications older than this
    const sevenDaysAgo = new Date();
    // Subtract 7 days from the current date
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    // Convert the date to an ISO string for database querying
    const cutoffDate = sevenDaysAgo.toISOString();

    // Query the database for applications that need follow-ups
    // We look for applications in the 'applied' status
    const { data: applications, error: appsError } = await db
      // Query the applications table
      .from("applications")
      // Select the ID, company, job title, and applied date
      .select("id, company_name, job_title, applied_at")
      // Filter for applications with status 'applied'
      .eq("status", "applied")
      // Filter for applications submitted before our cutoff date
      .lte("applied_at", cutoffDate)
      // Limit to 5 records to respect CPU time limits
      // This batching prevents the edge function from timing out
      .limit(5);

    // If there was an error querying the applications
    // We throw an error to be caught by the catch block
    if (appsError) {
      // Throw a standard error with the database error message
      throw new Error(`Failed to fetch applications: ${appsError.message}`);
    }

    // Process each application in the batch
    // We use a for-of loop to process them sequentially or concurrently
    // For simplicity and safety, we iterate sequentially here
    let processedCount = 0;
    
    // Check if we found any applications to process
    // If we have applications, we loop over them
    if (applications && applications.length > 0) {
      // Iterate over each application found
      for (const app of applications) {
        // Generate the follow-up nudge draft
        // We pass the application details to our shared module
        const draft = await generateFollowUpNudge({
          // Pass the company name from the db
          companyName: app.company_name,
          // Pass the job title from the db
          jobTitle: app.job_title,
          // Pass the application date
          applicationDate: app.applied_at,
        });

        // Insert the generated draft into the follow_up_nudges table
        // This makes it available in the web dashboard for the user to review
        const { error: insertError } = await db.from("follow_up_nudges").insert({
          // Link the nudge to the specific application ID
          application_id: app.id,
          // Store the generated subject line
          subject: draft.subject,
          // Store the generated email body
          body: draft.body,
          // Set the initial status of the nudge to 'draft'
          status: "draft",
        });

        // If the insert was successful, increment our counter
        // Otherwise, log the error but continue processing others
        if (!insertError) {
          // Increment the counter of successfully processed nudges
          processedCount++;
        } else {
          // Log the failure to insert the nudge
          console.error(`Failed to insert nudge for app ${app.id}:`, insertError);
        }
      }
    }

    // After processing all applications, return a success response
    // We include the number of processed applications in the JSON
    return new Response(JSON.stringify({ success: true, processed: processedCount }), {
      // Set the status code to 200 OK
      status: 200,
      // Include CORS and Content-Type headers
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    // If an error occurred during processing, log it
    // We cast error to any to safely access message
    console.error("Error in follow-up nudge job:", error);
    
    // Update the agent_run telemetry with the error status
    // This helps in debugging issues
    await db.from("agent_runs").update({
      // Set status to failed
      status: "failed",
      // Store the error message
      error_message: error.message || "Unknown error",
    // Match the specific run ID
    }).eq("id", runId);

    // Return a 500 Internal Server Error response
    // Let the client know something went wrong
    return new Response(JSON.stringify({ error: "internal_error" }), {
      // Set status code to 500
      status: 500,
      // Include CORS and Content-Type headers
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    // Finally block always runs, even on success or failure
    // We update the agent run status to completed if it hasn't failed
    // First we check if it didn't fail (we assume success if we reach here without throwing)
    // Actually, it's better to unconditionally set to completed if we didn't throw
    await db.from("agent_runs").update({
      // Set the status to completed
      status: "completed",
    // Match the specific run ID
    }).eq("id", runId).eq("status", "running"); // Only update if still running
  }
});
