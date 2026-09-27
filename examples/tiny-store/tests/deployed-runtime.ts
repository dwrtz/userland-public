// Makes the shared test runtime (scripts/runtime-harness.ts) behave like a
// deployed app in the two places where they differ:
//
// - A unique-index clash throws `unique_conflict` with status 400, the code the
//   Data guide documents, instead of the harness's `unique_violation` (409).
// - `ctx.data.transaction` only groups calls. It does not roll back writes
//   when the callback throws, and it does not stop two requests from running
//   at the same time.
import type { createFakeRuntime } from "../../../scripts/runtime-harness.js";

type Runtime = ReturnType<typeof createFakeRuntime>;
type AnyFn = (...args: never[]) => Promise<unknown>;

export function deployedRuntime<R extends Runtime>(runtime: R): R {
  const data = runtime.ctx.data;
  const original = data.collection;
  const asDeployed = <F extends AnyFn>(fn: F) =>
    (async (...args: Parameters<F>) => {
      try {
        return await fn(...args);
      } catch (error) {
        if ((error as { code?: string })?.code === "unique_violation") {
          throw Object.assign(new Error((error as Error).message), { code: "unique_conflict", status: 400 });
        }
        throw error;
      }
    }) as F;
  data.collection = ((name: string) => {
    const collection = original(name);
    return { ...collection, create: asDeployed(collection.create), update: asDeployed(collection.update) };
  }) as typeof data.collection;
  data.transaction = (async (callback: (tx: typeof data) => unknown) => await callback(data)) as typeof data.transaction;
  return runtime;
}
