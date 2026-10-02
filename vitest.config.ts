export default {
  test: {
    globals: true,
    // CLI tests run the built CLI as a child process, often many times in one test, which takes several
    // seconds on shared CI runners: several sat between 4 and 5 s, and one hit vitest's 5 s default.
    // A hang still fails, just later.
    testTimeout: 30_000,
    include: ["cli/**/*.test.ts", "examples/**/*.test.ts", "scripts/**/*.test.ts"]
  }
};
