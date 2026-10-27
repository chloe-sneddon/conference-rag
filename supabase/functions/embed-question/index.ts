import { createSupabaseContext } from "npm:@supabase/server@1";
import { corsHeaders } from "../_shared/cors.ts";

const MAX_QUESTION_LENGTH = 8_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Validate the caller's Supabase user JWT before using the paid OpenAI API.
  const { data: authContext, error: authError } = await createSupabaseContext(
    req,
    { auth: "user" },
  );
  if (authError || !authContext?.userClaims?.id) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }

  if (typeof payload !== "object" || payload === null || !("question" in payload)) {
    return jsonResponse({ error: "A question string is required" }, 400);
  }

  const questionValue = (payload as { question?: unknown }).question;
  if (typeof questionValue !== "string" || !questionValue.trim()) {
    return jsonResponse({ error: "A question string is required" }, 400);
  }

  const question = questionValue.trim();
  if (question.length > MAX_QUESTION_LENGTH) {
    return jsonResponse({ error: "Question is too long" }, 400);
  }

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    console.error("OPENAI_API_KEY is not configured for this function");
    return jsonResponse({ error: "Embedding service is not configured" }, 500);
  }

  try {
    const openAiResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: question,
      }),
    });

    if (!openAiResponse.ok) {
      console.error("OpenAI embeddings request failed with status", openAiResponse.status);
      return jsonResponse({ error: "Could not create an embedding" }, 502);
    }

    const result = await openAiResponse.json();
    const embedding = result?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      console.error("OpenAI embeddings response did not contain an embedding");
      return jsonResponse({ error: "Could not create an embedding" }, 502);
    }

    return jsonResponse({ embedding });
  } catch (error) {
    console.error("Embedding request failed:", error);
    return jsonResponse({ error: "Embedding service is unavailable" }, 502);
  }
});
