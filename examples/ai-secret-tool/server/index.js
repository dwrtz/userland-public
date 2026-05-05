function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

async function runTool(request, ctx) {
  const input = await request.json();
  const apiKey = await ctx.secrets.require("MODEL_API_KEY");
  const answer = await callMockModel(String(input.prompt ?? ""), apiKey);
  await ctx.log.info("model tool completed", { prompt_length: String(input.prompt ?? "").length });
  return json({ answer });
}

async function callMockModel(prompt, apiKey) {
  return `Mock model response for ${prompt.slice(0, 40)} using key prefix ${apiKey.slice(0, 4)}...`;
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

