import {
  CONNECTOR_OR_CLI,
  COMMANDS_HEADER,
  NOT_IN_INVENTORY,
  allSkillProblems,
  findOperation,
  loadInventory,
  loadMcpTools,
  loadSkills,
  parseUserlandCommand,
  skillProblems,
  type InventoryOperation
} from "./skill-operations.js";

const operations = await loadInventory();
const mcpTools = await loadMcpTools();
const skills = await loadSkills();

describe("skills and the operation inventory", () => {
  it("every skill's commands, options and connector tools match schemas/operations-v0.json, and the skills cover every operation", () => {
    expect(allSkillProblems(operations, skills, mcpTools)).toEqual([]);
  });

  it("lists only commands in NOT_IN_INVENTORY that the inventory still doesn't have", () => {
    for (const command of Object.keys(NOT_IN_INVENTORY)) {
      expect(findOperation(operations, command), command).toBeUndefined();
    }
  });

  it("gives every skill a description that says when to use it, in plain YAML", () => {
    for (const skill of skills) {
      const description = skill.body.match(/^description: (.*)$/mu)?.[1] ?? "";
      expect(description, skill.name).toMatch(/^Use when /u);
      expect(description.length, skill.name).toBeLessThanOrEqual(1024);
      // A colon and a space would end the value early for a YAML parser.
      expect(description, skill.name).not.toContain(": ");
    }
  });
});

describe("the check itself", () => {
  const skill = (rows: string[], extra = "") =>
    ["---", "name: t", "description: Use when testing.", "---", "", CONNECTOR_OR_CLI, "", "## Commands", "", COMMANDS_HEADER, "| --- | --- | --- |", ...rows, "", extra].join("\n");
  const problems = (rows: string[], extra = "") => skillProblems(operations, "t", skill(rows, extra), mcpTools).problems;

  it("passes a row whose tool and inputs match the inventory", () => {
    expect(problems(["| Publish | `apps_publish` with `draft_id`, `app_id` | `userland apps publish <dir> --app <app-id>` |"])).toEqual([]);
  });

  it("finds a wrong tool", () => {
    expect(problems(["| Publish | `apps_deploy` with `draft_id` | `userland apps publish <dir>` |"]).join("\n")).toContain("the tool for \"apps publish\" is `apps_publish`");
  });

  it("finds a tool input that doesn't match the options", () => {
    expect(problems(["| Publish | `apps_publish` with `draft_id` | `userland apps publish <dir> --app <app-id>` |"]).join("\n")).toContain("(app_id, draft_id)");
    expect(problems(["| Events | `apps_events` with `severity`, `colour` | `userland apps events <app-id> --severity error` |"]).join("\n")).toContain("has no input `colour`");
  });

  it("finds an option the command doesn't have", () => {
    expect(problems(["| Events | `apps_events` with `severity` | `userland apps events <app-id> --severity error --since 1h` |"]).join("\n")).toContain("--since is not an option");
  });

  it("finds a command the inventory doesn't have, anywhere in the skill", () => {
    expect(problems(["| Status | `apps_status` | `userland apps status <app-id>` |"], "Run `userland apps restart <app-id>`.").join("\n")).toContain('"apps restart" is not a command');
  });

  it("refuses a secret on the command line", () => {
    expect(problems(["| Set | `secrets_set` | `userland apps secrets set <app-id> <NAME> --value <value>` |"]).join("\n")).toContain("puts a secret on the command line");
  });

  it("refuses a tool for an operation the connector does by connecting", () => {
    expect(problems(["| Sign in | `auth_login` | `userland login` |"]).join("\n")).toContain("has no tool");
  });

  it("finds a tool name in the text that the inventory doesn't have", () => {
    expect(problems(["| Status | `apps_status` | `userland apps status <app-id>` |"], "Then call `apps_restart`.").join("\n")).toContain("`apps_restart` is not a tool");
  });

  it("checks connector-only draft tool names against the inventory", () => {
    const row = "| Status | `apps_status` | `userland apps status <app-id>` |";
    expect(problems([row], "Call `drafts_create`, then `drafts_write_file`.")).toEqual([]);
    expect(problems([row], "Call `drafts_replace`.").join("\n")).toContain("`drafts_replace` is not a tool");
  });

  it("finds a connector-only tool no skill describes", () => {
    expect(allSkillProblems(operations, skills, [...mcpTools, { tool: "drafts_archive" }])).toContain("No skill describes the connector-only tool `drafts_archive`.");
  });

  it("needs the shared Connector or CLI section", () => {
    const body = skill(["| Status | `apps_status` | `userland apps status <app-id>` |"]).replace(CONNECTOR_OR_CLI, "## Connector or CLI\n\nUse the CLI.");
    expect(skillProblems(operations, "t", body).problems.join("\n")).toContain("Connector or CLI");
  });

  it("finds an operation no skill covers", () => {
    const extra: InventoryOperation = { id: "apps.restart", effect: "write", cli: { command: "apps restart", aliases: [], status: "released" }, mcp: { via: "tool", tool: "apps_restart" } };
    expect(allSkillProblems([...operations, extra], skills)).toContain('No skill\'s Commands table has "apps restart" (apps.restart).');
  });

  it("parses piped and bracketed commands", () => {
    expect(parseUserlandCommand(`printf '%s' "$VALUE" | userland apps secrets set <app-id> <NAME>`)).toMatchObject({ command: "apps secrets set", stdin: true, flags: [] });
    expect(parseUserlandCommand("userland apps list [--account <account-id>]")).toMatchObject({ command: "apps list", flags: ["--account"] });
    expect(parseUserlandCommand("npm install -g @userland.fun/cli")).toBeNull();
  });
});
