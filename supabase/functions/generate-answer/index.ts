import { createSupabaseContext } from "npm:@supabase/server@1";
import { corsHeaders } from "../_shared/cors.ts";

const MAX_QUESTION_LENGTH = 8_000;
const MAX_CONTEXT_TALKS = 5;
const MAX_TALK_TEXT_LENGTH = 40_000;

type ContextTalk = {
  title: string;
  speaker: string;
  text: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function parseContextTalks(value: unknown): ContextTalk[] | null {
  if (!Array.isArray(value)) return null;

  const talks: ContextTalk[] = [];
  for (const item of value.slice(0, MAX_CONTEXT_TALKS)) {
    if (typeof item !== "object" || item === null) return null;
    const { title, speaker, text } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) return null;
    talks.push({
      title: typeof title === "string" && title.trim() ? title.trim() : "Untitled talk",
      speaker: typeof speaker === "string" && speaker.trim() ? speaker.trim() : "Unknown speaker",
      text: text.trim().slice(0, MAX_TALK_TEXT_LENGTH),
    });
  }
  return talks;
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

  if (typeof payload !== "object" || payload === null) {
    return jsonResponse({ error: "A question string is required" }, 400);
  }

  const { question: questionValue, context_talks: contextValue } = payload as {
    question?: unknown;
    context_talks?: unknown;
  };

  if (typeof questionValue !== "string" || !questionValue.trim()) {
    return jsonResponse({ error: "A question string is required" }, 400);
  }

  const question = questionValue.trim();
  if (question.length > MAX_QUESTION_LENGTH) {
    return jsonResponse({ error: "Question is too long" }, 400);
  }

  const contextTalks = parseContextTalks(contextValue);
  if (!contextTalks) {
    return jsonResponse({ error: "context_talks must be an array of { title, speaker, text }" }, 400);
  }
  if (contextTalks.length === 0) {
    return jsonResponse({ error: "At least one context talk is required" }, 400);
  }

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    console.error("OPENAI_API_KEY is not configured for this function");
    return jsonResponse({ error: "Answer service is not configured" }, 500);
  }

  const context = contextTalks
    .map((talk, i) => `[Talk ${i + 1}] "${talk.title}" by ${talk.speaker}\n${talk.text}`)
    .join("\n\n---\n\n");

  const systemPrompt =
    "You answer questions about General Conference talks of The Church of Jesus Christ of Latter-day Saints. " +
    "Use only the conference talks provided in the context. " +
    "Cite the talks you draw from by title and speaker, for example: (\"Talk Title\", Speaker Name). " +
    "If the provided talks do not answer the question, say so instead of guessing.";

  try {
    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Conference talks:\n\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });

    if (!openAiResponse.ok) {
      console.error("OpenAI chat request failed with status", openAiResponse.status);
      return jsonResponse({ error: "Could not generate an answer" }, 502);
    }

    const result = await openAiResponse.json();
    const answer = result?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      console.error("OpenAI chat response did not contain an answer");
      return jsonResponse({ error: "Could not generate an answer" }, 502);
    }

    return jsonResponse({ answer });
  } catch (error) {
    console.error("Answer request failed:", error);
    return jsonResponse({ error: "Answer service is unavailable" }, 502);
  }
});
