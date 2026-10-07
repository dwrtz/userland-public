import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pluginDir, pluginDrift, root } from "./build-plugin.js";

const readJson = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<string, any>;

describe("the Userland plugin (plugins/userland)", () => {
  it("has skills and a LICENSE that match their sources (npm run plugin:build)", async () => {
    expect(await pluginDrift()).toEqual([]);
  });

  it("has Claude and Codex manifests with the same permanent name, version and description", async () => {
    const claude = await readJson("plugins/userland/.claude-plugin/plugin.json");
    const codex = await readJson("plugins/userland/.codex-plugin/plugin.json");
    expect(claude.name).toBe("userland");
    expect(codex.name).toBe("userland");
    expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(codex.version).toBe(claude.version);
    expect(codex.description).toBe(claude.description);
    expect(claude.license).toBe("MIT");
    expect(codex.license).toBe("MIT");
    expect(codex.skills).toBe("./skills/");
    expect(codex.mcpServers).toBe("./.mcp.json");
  });

  it("connects to the Userland connector over HTTP, with nothing else to run", async () => {
    const mcp = await readJson("plugins/userland/.mcp.json");
    expect(mcp).toEqual({ mcpServers: { userland: { type: "http", url: "https://mcp.userland.fun/mcp" } } });
  });

  it("holds no programs, hooks or secrets", async () => {
    const entries = await readdir(pluginDir, { withFileTypes: true, recursive: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(pluginDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    const allowed = /^(?:\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json|\.mcp\.json|README\.md|LICENSE|skills\/[a-z-]+\/SKILL\.md)$/u;
    expect(files.filter((file) => !allowed.test(file))).toEqual([]);
    for (const file of files) {
      expect(await readFile(path.join(pluginDir, file), "utf8"), file).not.toMatch(/\b(?:sk|rk)_live_|-----BEGIN [A-Z ]*PRIVATE KEY-----|USERLAND_API_KEY=\S/u);
    }
  });

  it("has a README that says what it does, how to use it and what data it sends", async () => {
    const readme = await readFile(path.join(pluginDir, "README.md"), "utf8");
    expect(readme.split(/\s+/u).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    for (const heading of ["## What's in it", "## Install", "## Use it", "## What it sends"]) expect(readme).toContain(heading);
    expect(readme).toContain("https://userland.fun/legal/privacy/");
  });

  it("is listed in the repo's Claude and Codex marketplaces", async () => {
    const claude = await readJson(".claude-plugin/marketplace.json");
    expect(claude.name).toBe("userland");
    expect(claude.owner?.name).toBeTruthy();
    expect(claude.plugins).toEqual([expect.objectContaining({ name: "userland", source: "./plugins/userland" })]);
    const codex = await readJson(".agents/plugins/marketplace.json");
    expect(codex.plugins).toEqual([
      expect.objectContaining({
        name: "userland",
        source: { source: "local", path: "./plugins/userland" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }
      })
    ]);
  });

  it("has a CHANGELOG entry for its version", async () => {
    const { version } = await readJson("plugins/userland/.claude-plugin/plugin.json");
    const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
    expect(changelog.includes(`Plugin ${version}:`), `CHANGELOG.md needs an entry starting "Plugin ${version}:"`).toBe(true);
  });
});
