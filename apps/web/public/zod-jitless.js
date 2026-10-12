// Turns off zod's string-to-code JIT in the browser before zod loads (the page forbids eval).
// Parsing still works: it takes zod's interpreted path. Server code is unaffected.
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, {
  jitless: true,
});
