/** Ambient declaration for `next-logger` (ships no .d.ts of its own).
 *
 *  It is imported purely for its side effect — `instrumentation.ts` loads it to
 *  patch Next.js' internal logger + the global console onto the pino instance
 *  built by `next-logger.config.js`, which is what writes
 *  `<LIBI_HOME>/logs/server.log`. Nothing reads a value off the module, so the
 *  declaration is deliberately empty rather than a guessed shape. */
declare module "next-logger";
