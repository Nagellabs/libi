/**
 * "This handler is running inside a `libi.apply_ops` batch." A handler that would do something a batch
 * must not (call out to a platform, say) asks `inBatchContext()` and skips it, saying so in its result.
 * AsyncLocalStorage, like the draft transaction it runs beside (lib/composition/manifest-txn-scope.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<true>();

export function runInBatchContext<T>(fn: () => Promise<T>): Promise<T> {
  return als.run(true, fn);
}

export function inBatchContext(): boolean {
  return als.getStore() === true;
}
