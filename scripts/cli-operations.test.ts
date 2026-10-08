import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { behaviourDrift, parseUsage, pathPattern, probesFor, staticDrift, type InventoryOperation } from "./cli-operations.js";

const root = path.resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(path.join(root, "schemas", "operations-v0.json"), "utf8")) as { operations: InventoryOperation[] };

const HELP = `Usage:
  userland [--help]
  userland --version
  userland login [--no-browser] [--email <email>]
  userland apps slugs add <app-id> <slug> [--account <account-id>]
  userland apps download <app-id> [dir] [--version <release-id>] [--force]
  userland apps secrets set <app-id> <NAME> [--account <account-id>]   (reads the value from stdin)

Aliases:
  userland api-keys list|create ...
  userland apps pull <app-id> [dir] [--version <release-id>]

Validation:
  userland validate is not a command line here.
`;

const op = (id: string, command: string, inputs: InventoryOperation["inputs"], extra: Partial<InventoryOperation> = {}): InventoryOperation => ({
  id,
  kind: "api",
  cli: { command, aliases: [], status: "released" },
  inputs,
  api: [],
  ...extra
});
const flag = (cli: string, takes_value = false) => ({ cli, source: "flag" as const, required: false, takes_value, role: "input" });
const arg = (cli: string, required = true) => ({ cli, source: "argument" as const, required, takes_value: true, role: "input" });

describe("reading the CLI's help", () => {
  it("reads each command line's words, positional arguments and flags, from Usage and Aliases only", () => {
    const lines = parseUsage(HELP);
    expect(lines.map((line) => [line.section, line.command, line.args, line.flags])).toEqual([
      ["usage", "login", [], ["--no-browser", "--email"]],
      ["usage", "apps slugs add", ["<app-id>", "<slug>"], ["--account"]],
      ["usage", "apps download", ["<app-id>", "[dir]"], ["--version", "--force"]],
      ["usage", "apps secrets set", ["<app-id>", "<NAME>"], ["--account"]],
      ["aliases", "api-keys list", [], []],
      ["aliases", "api-keys create", [], []],
      ["aliases", "apps pull", ["<app-id>", "[dir]"], ["--version"]]
    ]);
  });

  it("reads the real help: every released operation is on it", () => {
    const cli = path.join(root, "cli", "dist", "index.js");
    if (!existsSync(cli)) return;
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(staticDrift(inventory.operations, parseUsage(`${help.stdout}${help.stderr}`))).toEqual([]);
  });
});

describe("drift between the help and the inventory", () => {
  const operations = [
    op("auth.login", "login", [flag("--no-browser"), flag("--email", true)]),
    op("slugs.add", "apps slugs add", [arg("<app-id>"), arg("<slug>"), flag("--account", true)]),
    { ...op("apps.download", "apps download", [arg("<app-id>"), arg("[dir]", false), flag("--version", true), flag("--force")]), cli: { command: "apps download", aliases: ["apps pull"], status: "released" as const } },
    op("secrets.set", "apps secrets set", [arg("<app-id>"), arg("<NAME>"), flag("--account", true), { cli: "stdin", source: "stdin", required: true, takes_value: true, role: "secret_value" }]),
    { ...op("api_keys.list", "auth api-keys list", []), cli: { command: "auth api-keys list", aliases: ["api-keys list"], status: "released" as const } },
    { ...op("api_keys.create", "auth api-keys create", []), cli: { command: "auth api-keys create", aliases: ["api-keys create"], status: "released" as const } }
  ];

  it("finds none when they agree", () => {
    const usage = parseUsage(HELP).concat(
      parseUsage("Usage:\n  userland auth api-keys list\n  userland auth api-keys create\n")
    );
    expect(staticDrift(operations, usage)).toEqual([]);
  });

  it("names a command, a flag or an argument the inventory doesn't have, and an operation the help lacks", () => {
    const usage = parseUsage(HELP);
    const drift = staticDrift(
      [
        op("auth.login", "login", [flag("--no-browser")]),
        op("slugs.add", "apps slugs add", [arg("<app-id>"), flag("--account", true)]),
        { ...op("apps.download", "apps download", [arg("<app-id>"), arg("[dir]", false), flag("--version", true), flag("--force")]), cli: { command: "apps download", aliases: ["apps pull"], status: "planned" as const } },
        op("apps.export", "apps export", [arg("<app-id>")])
      ],
      usage
    );
    expect(drift).toEqual(
      expect.arrayContaining([
        "`userland login` takes --email in the CLI's help, but auth.login has no such input in the inventory.",
        "`userland apps slugs add` takes 2 positional argument(s) in the CLI's help (<app-id> <slug>), but slugs.add lists 1 (<app-id>).",
        "`userland apps secrets set` is in the CLI's help, but no inventory operation has it as its command or an alias.",
        "The CLI has `userland apps download`, but the inventory still says apps.download is planned. Mark it released.",
        "apps.export is released in the inventory, but `userland apps export` isn't on a Usage line of the CLI's help."
      ])
    );
  });
});

describe("the probes", () => {
  it("match API paths one segment per parameter, and a `_path` parameter to the end", () => {
    expect(pathPattern("/v0/apps/:app_id/slugs/:slug").test("/v0/apps/app_1/slugs/oak")).toBe(true);
    expect(pathPattern("/v0/apps/:app_id/slugs/:slug").test("/v0/apps/app_1/slugs/oak/extra")).toBe(false);
    expect(pathPattern("/v0/apps/:app_id/releases/:release_id/files/:file_path").test("/v0/apps/a/releases/live/files/public/css/site.css")).toBe(true);
  });

  it("run the required inputs once, then each optional flag and alias once, and never without --no-browser where it applies", () => {
    const login = inventory.operations.find((operation) => operation.id === "auth.login")!;
    const probes = probesFor(login, { app: "/app", empty: "/empty" }, "http://127.0.0.1:9");
    expect(probes.every((probe) => probe.argv.includes("--no-browser"))).toBe(true);
    const slugs = inventory.operations.find((operation) => operation.id === "slugs.add")!;
    expect(probesFor(slugs, { app: "/app", empty: "/empty" }, "http://127.0.0.1:9").map((probe) => probe.argv.join(" "))).toEqual([
      "apps slugs add app_probe probe-address",
      "apps slugs add app_probe probe-address --account acct_probe"
    ]);
  });

  it("catch a flag the CLI refuses and a call the inventory doesn't list", { timeout: 60_000 }, async () => {
    const cli = path.join(root, "cli", "dist", "index.js");
    if (!existsSync(cli)) return;
    const slugs = inventory.operations.find((operation) => operation.id === "slugs.add")!;
    const renamed = { ...slugs, inputs: slugs.inputs.map((input) => (input.cli === "--account" ? { ...input, cli: "--business" } : input)), api: [] };
    const drift = await behaviourDrift([renamed], cli);
    expect(drift).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^`userland apps slugs add --business`: the CLI refuses an input the inventory lists for slugs\.add/u),
        expect.stringMatching(/^`userland apps slugs add \(required inputs only\)` calls POST \/v0\/apps\/app_probe\/slugs/u)
      ])
    );
  });
});
