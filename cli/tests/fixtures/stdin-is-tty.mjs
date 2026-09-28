// Loaded with `node --import` by the CLI tests: makes piped stdin look like a terminal, so a test
// can answer the CLI's confirmation prompts by writing to stdin.
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
