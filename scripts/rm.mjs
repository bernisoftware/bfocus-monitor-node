// Remove diretórios de build (multiplataforma, sem dependência): node scripts/rm.mjs dist dist-test
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const dir of process.argv.slice(2)) {
  rmSync(resolve(root, dir), { recursive: true, force: true });
}
