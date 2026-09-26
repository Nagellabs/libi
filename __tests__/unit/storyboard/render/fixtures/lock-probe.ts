// Run by lock-runtime.test.ts in its own node child: locks the runtime the way
// the storyboard worker does, then reports — as data — what code evaluated in
// the global scope can still reach. Every probe only asks whether a capability
// is THERE (typeof, or a harmless builtin's import rejecting); none uses one.
import { lockWorkerRuntime } from "@/lib/storyboard/render/lock-runtime";

const io = lockWorkerRuntime();

// Global-scope code, built at runtime, as a body that stepped around the
// validator's text filter would build it.
const globalEval = (src: string): unknown => new Function(src)();

async function importRejects(src: string): Promise<string> {
  try {
    await (globalEval(src) as Promise<unknown>);
    return "loaded";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

void (async () => {
  const report = {
    processKeys: globalEval("return Object.keys(process).sort().join(',')"),
    binding: globalEval("return typeof process.binding"),
    getBuiltinModule: globalEval("return typeof process.getBuiltinModule"),
    dlopen: globalEval("return typeof process.dlopen"),
    stdout: globalEval("return typeof process.stdout"),
    viaFunctionCtor: globalEval("return (function () {}).constructor('return typeof process.binding')()"),
    requireGlobal: globalEval("return typeof require"),
    moduleGlobal: globalEval("return typeof module"),
    redefine: globalEval(
      "try { Object.defineProperty(globalThis, 'process', { value: 1 }); return 'redefined'; } catch (e) { return 'refused'; }",
    ),
    dynamicImport: await importRejects("return import('node:path')"),
    envKeys: globalEval("return Object.keys(process.env).length"),
  };
  await io.writeStdout(Buffer.from(JSON.stringify(report)));
  io.exit(0);
})();
