import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Checks each skill's Userland commands and connector tools against the shared operation inventory
// (`schemas/operations-v0.json`, exported from dwrtz/userland#286). The MCP server builds its tools from the
// same inventory, so a skill that names a tool, a tool input, a CLI command or a CLI option the inventory
// doesn't have fails here instead of failing for an agent.
//
// Every skill has a Commands table with three columns: what to do, the connector tool, and the CLI command.
// For each row, the CLI command must be an inventory command, each of its options one of that command's
// inputs, and the tool the one the inventory gives that command, with the tool inputs that match the
// options used. Every `userland ...` command anywhere else in a skill is checked the same way, and every
// operation in the inventory must appear in at least one skill's table.

export const root = path.resolve(import.meta.dirname, "..");
export const skillsRoot = path.join(root, ".agents", "skills");
export const inventoryPath = path.join(root, "schemas", "operations-v0.json");

export interface InventoryInput {
  cli: string;
  source: "argument" | "flag" | "stdin";
  role: string;
  mcp_input?: string;
}

export interface InventoryOperation {
  id: string;
  effect: string;
  cli: { command: string; aliases: string[]; status: "released" | "planned" };
  inputs?: InventoryInput[];
  mcp: { via: string; tool?: string; status?: string };
}

/** The same words in every skill, so an agent picks one way into Userland and keeps to it. */
export const CONNECTOR_OR_CLI = `## Connector or CLI

There are two ways into Userland. Both run the same operations, with the same permissions, checks, errors and plan limits. Find out which one you have before you start, and use it for the whole task.

- **The Userland connector.** Userland's tools, such as \`auth_status\` and \`apps_publish\`, are in your tool list: in ChatGPT or Claude with Userland added, or in a coding agent with the Userland plugin. Use the "Connector tool" column below. Don't switch to a terminal for any step, and don't ask the owner to install anything.
- **The Userland CLI.** There are no Userland tools, and you can run commands in a terminal. Use the "CLI command" column below. The CLI needs Node.js 20 or newer: \`npm install -g @userland.fun/cli\`.
- **Neither.** Tell the owner how to add Userland to their assistant: https://docs.userland.fun/guides/chat-assistants/.

When a tool or a command fails, tell the owner what its error says and follow its next steps. Don't retry the step the other way. Secret values and API keys never go in the chat: the connector gives the owner a Userland page to type a secret on, and the CLI reads one from stdin.`;

/** The Commands table's header row. */
export const COMMANDS_HEADER = "| What to do | Connector tool | CLI command |";

/**
 * Userland CLI commands that skills use but the inventory doesn't list yet, and why. A row with one of these has
 * no connector tool, and its "Connector tool" cell says what to do instead. The check fails once the inventory
 * lists the command, so the row gets its tool and the entry is removed.
 */
export const NOT_IN_INVENTORY: Readonly<Record<string, string>> = {
  "apps export":
    "Added to the CLI after the inventory was taken from CLI 0.11.0. Its entry and MCP counterpart come with dwrtz/userland#286 (250p, public#38 p38b); until then, the console's app settings page makes the same copy."
};

/** Input roles that never have a tool input of their own: which business (`account_id` is the same for every tool), output format, and CLI-only plumbing. */
const ROLES_WITHOUT_TOOL_INPUT = new Set(["account", "output", "interface", "local_validation", "local_credential"]);

/** Input roles whose values must never be on a command line in a skill: they go on stdin, or through the connector's protected entry. */
const ROLES_NEVER_ON_THE_COMMAND_LINE = new Set(["secret_value", "local_credential"]);

export async function loadInventory(): Promise<InventoryOperation[]> {
  const document = JSON.parse(await readFile(inventoryPath, "utf8")) as { operations?: InventoryOperation[] };
  if (!Array.isArray(document.operations)) throw new Error("schemas/operations-v0.json must have an operations array.");
  return document.operations;
}

export async function loadSkills(): Promise<Array<{ name: string; body: string }>> {
  const dirs = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(dirs.map(async (name) => ({ name, body: await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8") })));
}

export interface ParsedCommand {
  /** The command as written, from `userland` on. */
  text: string;
  /** The command words, such as `apps publish`. Empty for `userland --version`. */
  command: string;
  flags: string[];
  arguments: string[];
  /** True when something is piped into it. */
  stdin: boolean;
}

/** Parses one shell line or code span that runs `userland`; returns null when it doesn't. */
export function parseUserlandCommand(source: string): ParsedCommand | null {
  const match = source.match(/(^|\|\s*|\s)userland\s+(.*)$/u);
  if (!match) return null;
  const rest = match[2].trim();
  const tokens = rest.match(/"[^"]*"|'[^']*'|[^\s[\]]+/gu) ?? [];
  const words: string[] = [];
  let index = 0;
  while (index < tokens.length && /^[a-z][a-z-]*$/u.test(tokens[index])) words.push(tokens[index++]);
  const flags: string[] = [];
  const args: string[] = [];
  for (const token of tokens.slice(index)) {
    if (token.startsWith("--")) flags.push(token.split("=")[0]);
    else if (token.startsWith("<") || /^[A-Za-z]/u.test(token)) args.push(token);
  }
  return { text: `userland ${rest}`, command: words.join(" "), flags, arguments: args, stdin: match[1].includes("|") };
}

/** The inventory operation for a command's words (its command or one of its aliases). */
export function findOperation(operations: readonly InventoryOperation[], command: string): InventoryOperation | undefined {
  return operations.find((operation) => operation.cli.command === command || operation.cli.aliases.includes(command));
}

export interface CommandsRow {
  line: number;
  task: string;
  toolCell: string;
  cliCell: string;
}

/** The rows of a skill's Commands table (the table under `## Commands`). */
export function commandsRows(body: string): { header: string | null; rows: CommandsRow[] } {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Commands");
  if (start === -1) return { header: null, rows: [] };
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  const tableLines = lines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .slice(start + 1, end)
    .filter((entry) => entry.text.startsWith("|"));
  if (tableLines.length === 0) return { header: null, rows: [] };
  const rows = tableLines.slice(2).map((entry) => {
    const cells = splitRow(entry.text);
    return { line: entry.line, task: cells[0] ?? "", toolCell: cells[1] ?? "", cliCell: cells[2] ?? "" };
  });
  return { header: tableLines[0].text, rows };
}

function splitRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 1; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\\" && row[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  return cells;
}

/** The tool cell: a tool name in backticks, optionally "with" and its inputs in backticks; anything else means no tool. */
export function parseToolCell(cell: string): { tool: string | null; inputs: string[] } {
  const match = cell.match(/^`([a-z][a-z_]*)`(?:\s+with\s+(.+))?$/u);
  if (!match) return { tool: null, inputs: [] };
  const inputs = [...(match[2] ?? "").matchAll(/`([a-z][a-z_]*)`/gu)].map((input) => input[1]);
  return { tool: match[1], inputs };
}

/** Every `userland ...` command in a skill: in code spans, and on the lines of code blocks. */
export function userlandCommands(body: string): Array<{ line: number; command: ParsedCommand }> {
  const found: Array<{ line: number; command: ParsedCommand }> = [];
  let inBlock = false;
  body.split("\n").forEach((text, index) => {
    if (text.trim().startsWith("```")) {
      inBlock = !inBlock;
      return;
    }
    const sources = inBlock ? [text] : [...text.matchAll(/`([^`]+)`/gu)].map((span) => span[1]);
    for (const source of sources) {
      const command = parseUserlandCommand(source.replace(/\\\|/gu, "|"));
      if (command && command.command !== "") found.push({ line: index + 1, command });
    }
  });
  return found;
}

/** Problems with one command: unknown command, unknown option, a secret on the command line, or stdin it doesn't read. */
export function commandProblems(operations: readonly InventoryOperation[], command: ParsedCommand): string[] {
  if (Object.hasOwn(NOT_IN_INVENTORY, command.command)) return [];
  const operation = findOperation(operations, command.command);
  if (!operation) return [`\`${command.text}\`: "${command.command}" is not a command in schemas/operations-v0.json.`];
  const problems: string[] = [];
  const inputs = operation.inputs ?? [];
  for (const flag of command.flags) {
    const input = inputs.find((candidate) => candidate.cli === flag);
    if (!input) {
      // A planned command's options aren't settled yet (the inventory's own drift check skips them too).
      if (operation.cli.status === "planned") continue;
      problems.push(`\`${command.text}\`: ${flag} is not an option of "${operation.cli.command}" in schemas/operations-v0.json.`);
    } else if (ROLES_NEVER_ON_THE_COMMAND_LINE.has(input.role)) {
      problems.push(`\`${command.text}\`: ${flag} puts a secret on the command line; pass it on stdin.`);
    }
  }
  if (command.stdin && !inputs.some((input) => input.source === "stdin")) {
    problems.push(`\`${command.text}\`: "${operation.cli.command}" doesn't read stdin.`);
  }
  return problems;
}

/** Problems with one Commands row: its command, and whether its tool and tool inputs match the inventory. */
export function rowProblems(operations: readonly InventoryOperation[], row: CommandsRow): { problems: string[]; operation: InventoryOperation | null } {
  const where = `Commands row "${row.task}"`;
  const cli = row.cliCell.match(/^`([^`]+)`$/u);
  const command = cli ? parseUserlandCommand(cli[1]) : null;
  if (!command || command.command === "") return { problems: [`${where}: the CLI command cell must be one \`userland ...\` command.`], operation: null };
  const problems = commandProblems(operations, command).map((problem) => `${where}: ${problem}`);
  const { tool, inputs } = parseToolCell(row.toolCell);

  if (Object.hasOwn(NOT_IN_INVENTORY, command.command)) {
    if (findOperation(operations, command.command)) {
      problems.push(`${where}: "${command.command}" is in the inventory now; give the row its tool and remove it from NOT_IN_INVENTORY.`);
    }
    if (tool) problems.push(`${where}: "${command.command}" has no tool in the inventory yet, so the tool cell must say what to do instead.`);
    return { problems, operation: null };
  }
  const operation = findOperation(operations, command.command);
  if (!operation) return { problems, operation: null };

  if (operation.mcp.via !== "tool" || !operation.mcp.tool) {
    if (tool) problems.push(`${where}: "${operation.cli.command}" has no tool (the inventory says it's done by ${operation.mcp.via}), but the row names \`${tool}\`.`);
    return { problems, operation };
  }
  if (tool !== operation.mcp.tool) {
    problems.push(`${where}: the tool for "${operation.cli.command}" is \`${operation.mcp.tool}\`, not ${tool ? `\`${tool}\`` : "missing"}.`);
    return { problems, operation };
  }
  const toolInputs = new Set((operation.inputs ?? []).flatMap((input) => (input.mcp_input ? [input.mcp_input] : [])));
  for (const input of inputs) {
    if (!toolInputs.has(input)) problems.push(`${where}: \`${tool}\` has no input \`${input}\`.`);
  }
  if (operation.cli.status === "released") {
    const expected = new Set<string>();
    for (const input of operation.inputs ?? []) {
      if (!input.mcp_input || ROLES_WITHOUT_TOOL_INPUT.has(input.role)) continue;
      if (input.source === "flag" && command.flags.includes(input.cli)) expected.add(input.mcp_input);
      if (input.source === "argument" && input.role === "files") expected.add(input.mcp_input);
    }
    const listed = [...new Set(inputs)].sort().join(", ");
    const wanted = [...expected].sort().join(", ");
    if (listed !== wanted) {
      problems.push(`${where}: \`${tool}\` should list the inputs that match the CLI command's options (${wanted || "none"}), not (${listed || "none"}).`);
    }
  }
  return { problems, operation };
}

/** Tool names in a skill's text: backticked words that start like an inventory tool. Each must be one. */
export function toolMentionProblems(operations: readonly InventoryOperation[], body: string): string[] {
  const tools = new Set(operations.flatMap((operation) => (operation.mcp.tool ? [operation.mcp.tool] : [])));
  const prefixes = [...new Set(operations.map((operation) => operation.id.split(".")[0]))];
  const pattern = new RegExp(`^(?:${prefixes.join("|")})_[a-z_]+$`, "u");
  const problems: string[] = [];
  for (const span of body.matchAll(/`([a-z][a-z_]*)`/gu)) {
    if (pattern.test(span[1]) && !tools.has(span[1])) problems.push(`\`${span[1]}\` is not a tool in schemas/operations-v0.json.`);
  }
  return [...new Set(problems)];
}

/** Every problem with one skill. */
export function skillProblems(operations: readonly InventoryOperation[], name: string, body: string): { problems: string[]; operations: Set<string> } {
  const problems: string[] = [];
  const covered = new Set<string>();
  if (!body.includes(CONNECTOR_OR_CLI)) problems.push("is missing the shared \"## Connector or CLI\" section (CONNECTOR_OR_CLI in scripts/skill-operations.ts), word for word.");
  const { header, rows } = commandsRows(body);
  if (header !== COMMANDS_HEADER) problems.push(`its Commands section must start with the table header ${COMMANDS_HEADER}`);
  if (rows.length === 0) problems.push("its Commands table has no rows.");
  for (const row of rows) {
    const result = rowProblems(operations, row);
    problems.push(...result.problems);
    if (result.operation) covered.add(result.operation.id);
  }
  for (const { line, command } of userlandCommands(body)) {
    for (const problem of commandProblems(operations, command)) problems.push(`line ${line}: ${problem}`);
  }
  problems.push(...toolMentionProblems(operations, body));
  return { problems: [...new Set(problems)].map((problem) => `${name}: ${problem}`), operations: covered };
}

/** Every problem across the skills, including inventory operations no skill's table covers. */
export function allSkillProblems(operations: readonly InventoryOperation[], skills: ReadonlyArray<{ name: string; body: string }>): string[] {
  const problems: string[] = [];
  const covered = new Set<string>();
  for (const skill of skills) {
    const result = skillProblems(operations, skill.name, skill.body);
    problems.push(...result.problems);
    for (const id of result.operations) covered.add(id);
  }
  for (const operation of operations) {
    if (!covered.has(operation.id)) problems.push(`No skill's Commands table has "${operation.cli.command}" (${operation.id}).`);
  }
  return problems;
}
