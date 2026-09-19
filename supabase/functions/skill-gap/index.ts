// Import Deno standard HTTP server
// This is required for Edge Functions
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
// Import standard CORS headers
// We will return these with every response
import { corsHeaders } from "../_shared/cors.ts";
// Import the database client factory
// This connects to Supabase using the user's token
import { createAppUserClient } from "../_shared/db/client.ts";
// Import the skill extractor module
// This finds skills in job descriptions
import { extractRequiredSkills } from "../_shared/analytics/skill-extractor.ts";
// Import the skill gap logic
// This diffs candidate skills against required skills
import { computeSkillGaps } from "../_shared/analytics/skill-gap.ts";

// Serve the HTTP request
// This is the entrypoint for the Edge Function
Deno.serve(async (req: Request): Promise<Response> => {
    // Handle CORS preflight requests
    // Browser sends OPTIONS before the actual request
    if (req.method === "OPTIONS") {
        // Return 204 No Content with CORS headers
        // This allows the browser to proceed
        return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // Connect to the database using the client wrapper
    // This ensures RLS is respected
    const connection = await createAppUserClient();
    
    // Check if the connection was successful
    // If not, return a 503 error
    if (!connection.ok) {
        // Database is unavailable
        // Return JSON error response
        return new Response(JSON.stringify({ error: "database_unavailable" }), {
            // Include standard headers
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            // Service Unavailable status code
            status: 503
        });
    }

    // Extract the database client from the connection
    // We will use this to run queries
    const db = connection.db;

    // Check the global kill switch to ensure system is enabled
    // This prevents background jobs from running if disabled
    const { data: settings, error: settingsError } = await db
        // Query the system_settings table
        // We only care about the system_enabled flag
        .from('system_settings')
        // Select just the enabled column
        // We only need the first row
        .select('system_enabled')
        // Get single row
        // Limit 1
        .single();

    // If the system is disabled or we couldn't fetch settings
    // Return early to prevent processing
    if (settingsError || !settings?.system_enabled) {
        // Return a 503 error
        // System is currently disabled
        return new Response(JSON.stringify({ error: "system_disabled" }), {
            // Include CORS headers
            // Content type JSON
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            // Status code 503
            // Service Unavailable
            status: 503
        });
    }

    // Create a new agent run record for telemetry
    // This tracks the execution of this job
    const runId = crypto.randomUUID();
    // Insert the start record
    // Status is running initially
    await db.from('agent_runs').insert({
        // The unique run ID
        id: runId,
        // The name of the agent
        agent_name: 'skill_gap_aggregator',
        // The current status
        status: 'running',
        // Start time
        started_at: new Date().toISOString()
    });

    try {
        // Fetch applications that have been scored or applied
        // We need the job description and candidate profile to compute gaps
        const { data: applications, error: appsError } = await db
            // Query the applications table
            // We need jobs with descriptions
            .from('applications')
            // Select required fields
            // We need job_description and candidate_profile
            .select(`
                id,
                status,
                job_description,
                candidate_profile
            `)
            // Filter by relevant statuses
            // We only care about scored or applied
            .in('status', ['scored', 'applied'])
            // Limit batch size to avoid memory issues
            // CPU operations are deterministic here, so 200 is fine
            .limit(200);

        // Check for query errors
        // If we fail to fetch, throw to catch block
        if (appsError) {
            // Throwing sends it to the error handler
            // Which logs it and updates the run status
            throw new Error(`Failed to fetch applications: ${appsError.message}`);
        }

        // Initialize a map to aggregate demand counts
        // Key is the skill name, value is the demand count
        const skillDemandMap = new Map<string, number>();

        // Iterate over each fetched application
        // To compute gaps and aggregate
        for (const app of (applications || [])) {
            // If the job description is missing
            // We cannot extract skills, so skip
            if (!app.job_description) {
                // Continue to the next application
                // Nothing to do here
                continue;
            }

            // Extract required skills from the job description
            // This returns an array of skill strings
            const requiredSkills = extractRequiredSkills(app.job_description);
            
            // Compute the skill gaps for this application
            // This compares required against candidate skills
            const gaps = computeSkillGaps({
                // Pass in the required skills
                // We just extracted them
                requiredSkills,
                // Pass in the candidate profile
                // This might be null
                candidateProfile: app.candidate_profile
            });

            // Iterate over each computed gap
            // To aggregate the demand
            for (const gap of gaps) {
                // Get the current demand count for this skill
                // Default to 0 if not seen yet
                const currentCount = skillDemandMap.get(gap.skill) || 0;
                // Increment the demand count
                // And store it back in the map
                skillDemandMap.set(gap.skill, currentCount + 1);
            }
        }

        // Prepare records for upserting into the database
        // Convert the map to an array of objects
        const upsertRecords = Array.from(skillDemandMap.entries()).map(([skill, count]) => ({
            // The skill name
            skill_name: skill,
            // The aggregated demand count
            demand_count: count,
            // Update the last_calculated timestamp
            last_calculated_at: new Date().toISOString()
        }));

        // If we have records to upsert
        // Proceed with database operation
        if (upsertRecords.length > 0) {
            // Upsert into skill_gap_reports
            // This inserts or updates based on the skill name
            const { error: upsertError } = await db
                // Target the skill_gap_reports table
                // This stores aggregated data
                .from('skill_gap_reports')
                // Perform the upsert
                // On conflict with skill_name
                .upsert(upsertRecords, { onConflict: 'skill_name' });

            // Check for upsert errors
            // Throw to error handler if failed
            if (upsertError) {
                // Log and update status
                // By throwing an error
                throw new Error(`Failed to upsert skill gaps: ${upsertError.message}`);
            }
        }

        // Update the agent run status to completed
        // Job finished successfully
        await db.from('agent_runs')
            // Target this specific run
            // By ID
            .update({
                // Set status to completed
                // This indicates success
                status: 'completed',
                // Record the finish time
                // For telemetry
                finished_at: new Date().toISOString()
            })
            // Match the run ID
            // That we generated earlier
            .eq('id', runId);

        // Return a successful response
        // Indicate how many skills were aggregated
        return new Response(JSON.stringify({ 
            // Success flag
            // Job done
            success: true, 
            // Number of aggregated skills
            // For logging purposes
            aggregatedSkills: upsertRecords.length 
        }), {
            // Include CORS headers
            // Content type JSON
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            // Status code 200 OK
            // Success
            status: 200
        });

    } catch (err: any) {
        // Handle any errors that occurred during processing
        // Update the agent run status to failed
        await db.from('agent_runs')
            // Target this specific run
            // By ID
            .update({
                // Set status to failed
                // This indicates an error
                status: 'failed',
                // Record the finish time
                // Even on failure
                finished_at: new Date().toISOString(),
                // Store the error message
                // For debugging
                error_message: err.message
            })
            // Match the run ID
            // That we generated earlier
            .eq('id', runId);

        // Return a 500 error response
        // Internal Server Error
        return new Response(JSON.stringify({ 
            // Error key
            // The message
            error: err.message 
        }), {
            // Include CORS headers
            // Content type JSON
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            // Status code 500
            // Internal Server Error
            status: 500
        });
    }
});
