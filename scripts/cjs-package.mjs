// Marca dist/cjs como CommonJS. A raiz do pacote é "type": "module"; sem este arquivo o Node
// leria os .js de dist/cjs como ESM e o `require(...)` do pacote quebraria.
import { writeFileSync } from "node:fs";

writeFileSync(new URL("../dist/cjs/package.json", import.meta.url), `${JSON.stringify({ type: "commonjs" })}\n`);
