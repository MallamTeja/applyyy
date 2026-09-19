// Export standard CORS headers for edge functions
// Allows browser fetch requests from applyyy web UI
export const corsHeaders = {
  // Allow all origins for web app cross-origin fetch
  "Access-Control-Allow-Origin": "*",
  // Allow standard headers including authorization, apikey, and content-type
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Allow standard HTTP methods
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};
