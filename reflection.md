# Conference Talk RAG — Reflection

**Chloe Sneddon** · CS 452

- Repository: https://github.com/chloe-sneddon/conference-rag
- Live site: https://chloe-sneddon.github.io/conference-rag/

## Custom Feature: Ask a Specific Speaker

I added a custom feature where RAG results can be filtered based on a selected speaker (I chose three for this example: President Nelson, President Oaks, and Elder Holland). I chose this because people often want to know what a specific leader has taught on a topic, not just what was said in general. The speaker is picked from a drop-down list on the RAG panel, and the default "All speakers" option works the same as before.

The way it works is a new database function, `match_sentences_by_speaker`. It first filters the sentences to only that speaker. Speaker names are stored like "By President Russell M. Nelson" (with a non-breaking space), so it matches on the name appearing within the stored value instead of an exact comparison. After it selects only that person's sentences, the same cosine-similarity search is applied to them, and the top matches go through the normal RAG pipeline to GPT-4o. It checks every one of that speaker's sentences instead of using the HNSW index, because pgvector applies a filter only after its approximate index search, which would leave too few results. The drop-down limits what the site sends, but the function would still be safe if someone called it directly: the name is passed as a parameter, not built into the SQL, and RLS still only lets logged-in users read the data.

## 1. Security Architecture

| Sensitive asset | Where it lives | What protects it |
|---|---|---|
| Anon key | `config.public.json`, in the browser | Nothing needs to: it only identifies requests as the `anon` role, and RLS decides what that role can do |
| Conference data (`sentence_embeddings`) | Supabase Postgres | RLS policy: only `authenticated` users can read |
| Service role key | `config.secret.json`, local scripts only | Never committed or sent to the browser |
| OpenAI API key | Supabase Edge Function secret | Only server-side code can read it, and the functions require a logged-in user before using it |

The anon key is safe to expose because of Row Level Security (RLS) policies created in Supabase. The anon key by itself doesn't grant anything; it just tells Supabase the request is from an anonymous visitor, and the RLS policies decide what rows that role can see. In my app, someone with only the anon key can't read `sentence_embeddings` at all, because that table's policy only allows `authenticated` users. The `page_views` table is intentionally public, so anyone can insert and read page views. Anonymous requests also have a short 3 second statement timeout.

If someone got the service role key, that would be a much bigger issue, because the service role bypasses RLS completely. They would have unrestricted read/write access to every table and could read, change, or delete all of the data.

Edge Functions protect the OpenAI key because it is stored as a Supabase secret and only read by the function while it runs on Supabase's servers. It is never sent to the browser, so it can't be found in the page's JavaScript or network requests. The functions also check that the user is logged in before calling OpenAI, so strangers can't spend my OpenAI credits.

RLS is the last line of defense for the data: even though the anon key and database URL are public, the database itself enforces who can read which rows.

## 2. Edge Functions & the "Secure Middle"

Calling OpenAI from the browser would require putting the API key in the JavaScript that gets sent to every visitor. Anyone could open DevTools and copy it, then use it to make their own requests on my account.

The flow works like this:
1. The user submits a question in the browser, and the browser calls the Edge Function, sending the question along with the user's login token (JWT).
2. The Edge Function runs on Supabase's servers. It verifies the JWT, then reads `OPENAI_API_KEY` from its secrets.
3. The function calls OpenAI directly, server to server.
4. Only the result (the embedding or the answer) is sent back to the browser.

JWT verification proves who the user is. The JWT is the session token from the magic-link login. I deployed the functions with `--no-verify-jwt` and checked the token inside the function instead, so a request without a valid logged-in user gets a 401 before OpenAI is ever called.

This pattern applies to most production apps that use a paid or private service: payment processing like Stripe, sending email, or any third-party API with a secret key. The browser talks to your own backend, and only the backend holds the secret.

## 3. From SQL to Semantics

ILIKE is case-insensitive pattern matching on the text itself (I used it for the speaker filter), whereas cosine similarity compares meaning. With semantic search it doesn't have to be the same word; "happy" and "joy" have similar meanings.

This is where one succeeds and the other fails. If I search "happy" but the talks say "joy" and never use the word "happy," ILIKE won't find them, but cosine similarity can, because those are semantically similar. ILIKE can also match the wrong thing: `%happy%` matches "unhappy" too.

ILIKE is better when you need an exact name, scripture reference, or phrase, like "Moroni 10:4," where a similar-meaning result would be wrong. It's also cheaper, since it doesn't need an OpenAI call. Semantic search is better for natural questions where the wording won't match the talks.

Semantic search "understands" meaning because of the embedding model. It was trained on huge amounts of text, so it places sentences with similar meanings close together as vectors in 1,536-dimensional space. Cosine similarity measures how closely two vectors point in the same direction, so a question ends up close to sentences that mean the same thing even with different words.

## 4. RAG vs Fine-Tuning

Fine-tuning is further training an existing model on your own examples, which changes the model's weights. RAG is where the model doesn't have this information in its training and weights; instead, the app queries the database for relevant text and gives it to the model with the question.

RAG is better for this app because it can be much more specific. The answer is based on the exact talks it was given, so it can cite which talks it used, and adding new conference talks just means scraping and embedding them instead of retraining the model. Fine-tuning is better for changing how a model behaves, like a consistent tone, output format, or a narrow specialized task, whereas RAG works better for a large, changing knowledge base where the facts and sources matter.

## 5. AI-Assisted Development

The AI did really well building the edge functions, but it had a lot of guidance from the documentation on how to do that. One place I had to guide it was that ChatGPT kept trying to change the project documentation and provided code to match its own goals and not what the project goals are. I had to do a lot more guidance to keep it working towards the same goal as this project. I learned that Claude does this much better. I also learned that saying something once in a session is not enough; if it's important, it may need to be repeated multiple times. Over a long session the AI can drift away from earlier instructions, so I need to be aware of when that context drift is taking place.

I also learned to question the AI's diagnosis. When semantic search was timing out, I asked how it knew the timeout was the real issue instead of accepting the first fix. It turned out the vector index had already finished building, and checking the database directly was what actually showed that.
