import * as z from "./external.ts";

export * from "./external.ts";
// See the note in `src/index.ts` — aliasing keeps the default export shakable.
export { z, z as default };
