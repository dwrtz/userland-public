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

async function runTool(request, ctx) {
  const input = await request.json();
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) {
    return json({ error: "prompt_required" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return json({ error: "prompt_too_long", max_length: MAX_PROMPT_LENGTH }, { status: 400 });
  }

  // The key is read on the server for each request and never leaves it.
  const apiKey = await ctx.secrets.require("MODEL_API_KEY");
  const answer = await callMockModel(prompt, apiKey);

  // Log sizes, not prompt text: prompts can contain private user data.
  await ctx.log.info("model tool completed", { prompt_length: prompt.length, answer_length: answer.length });
  return json({ answer });
}

// Replace this with a real provider request, for example:
//   const response = await fetch(PROVIDER_URL, {
//     method: "POST",
//     headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
//     body: JSON.stringify({ input: prompt })
//   });
// Return only the model output. Never return or log the key or any part of it.
async function callMockModel(prompt, apiKey) {
  if (!apiKey) {
    throw new Error("MODEL_API_KEY is empty.");
  }
  return `Mock model response for: ${prompt.slice(0, 40)}`;
}

export default {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/run" && request.method === "POST") {
      return await runTool(request, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};
