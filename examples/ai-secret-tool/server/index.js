function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

const MAX_PROMPT_LENGTH = 4000;
const MAX_BODY_BYTES = 16_000;
// Caps what one request can cost: pass it to the provider as its output limit
// (max_tokens, max_output_tokens, ...) and trim whatever comes back.
const MAX_ANSWER_TOKENS = 500;
const MAX_ANSWER_LENGTH = 4000;

// Only this app's own page may call /api/run. Every app on apps.userland.fun
// counts as the same "site", and a plain HTML form on any site can post a
// text body here, so without these checks other pages could spend the
// provider credit through a visitor's browser. Browsers send Origin on every
// POST (a sandboxed page sends "null", which is rejected too). Requests with
// neither Origin nor Sec-Fetch-Site (curl, tests) are not from a browser.
function isSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads a JSON object body. Plain HTML forms cannot send application/json, and
// a script on another origin would need a CORS preflight this app never allows.
async function readJson(request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { response: json({ error: "json_required" }, { status: 415 }) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { response: json({ error: "body_too_large" }, { status: 413 }) };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: json({ error: "invalid_json" }, { status: 400 }) };
  }
  return { body };
}

async function runTool(request, ctx) {
  const { body: input, response } = await readJson(request);
  if (response) return response;
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) {
    return json({ error: "prompt_required" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return json({ error: "prompt_too_long", max_length: MAX_PROMPT_LENGTH }, { status: 400 });
  }

  // The key is read on the server for each request and never leaves it.
  let apiKey;
  try {
    apiKey = await ctx.secrets.require("MODEL_API_KEY");
  } catch (error) {
    await ctx.log.error("model key unavailable", { code: String(error?.code ?? "unknown") });
    return json({ error: "model_unavailable" }, { status: 503 });
  }

  // Provider errors can quote part of the key, the account's billing state,
  // or the provider's own message. Uncaught, the platform would pass an
  // error's message and status straight to the visitor, so catch everything,
  // log only the status and code, and answer with a generic error.
  let answer;
  try {
    answer = await model.call(prompt, apiKey);
  } catch (error) {
    await ctx.log.error("model call failed", {
      status: Number(error?.status) || null,
      code: typeof error?.code === "string" ? error.code.slice(0, 100) : null
    });
    return json({ error: "model_unavailable" }, { status: 502 });
  }
  answer = String(answer ?? "").slice(0, MAX_ANSWER_LENGTH);

  // Log sizes, not prompt text: prompts can contain private user data.
  await ctx.log.info("model tool completed", { prompt_length: prompt.length, answer_length: answer.length });
  return json({ answer });
}

// Replace this with a real provider request, for example:
//   const response = await fetch(PROVIDER_URL, {
//     method: "POST",
//     headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
//     body: JSON.stringify({ input: prompt, max_output_tokens: MAX_ANSWER_TOKENS })
//   });
//   if (!response.ok) throw Object.assign(new Error("provider error"), { status: response.status });
//   return (await response.json()).output_text;
// Return only the model output. Never return or log the key or any part of it.
// Before you connect a real key, add sign-in and a daily limit (AGENT.md step 2).
async function callMockModel(prompt, apiKey) {
  if (!apiKey) {
    throw new Error("MODEL_API_KEY is empty.");
  }
  return `Mock model response for: ${prompt.slice(0, 40)}`;
}

// The model call the route uses. Tests swap `call` to simulate provider errors.
export const model = { call: callMockModel };

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/run" && request.method === "POST") {
      if (!isSameOrigin(request, url)) {
        return json({ error: "cross_origin_request" }, { status: 403 });
      }
      return await runTool(request, ctx);
    }
    return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};
