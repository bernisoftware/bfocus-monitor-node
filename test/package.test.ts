/** O pacote construído importa em ESM e CJS, com tipos, zero dependências e a versão travada. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import * as esm from "@bfocus/monitor-node";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const RELEASE = new URL("../../release.json", import.meta.url);
const require = createRequire(import.meta.url);

const RUNTIME_EXPORTS = [
  "SDK_NAME",
  "VERSION",
  "addBreadcrumb",
  "captureException",
  "captureMessage",
  "close",
  "expressErrorHandler",
  "expressRequestHandler",
  "fastifyMonitor",
  "flush",
  "init",
  "parseStack",
  "setTag",
  "setUser",
  "signUserHash",
  "withContext",
  "withMonitor",
];

describe("pacote", () => {
  it("VERSION == package.json == src/version.ts", () => {
    assert.equal(esm.VERSION, PKG.version);
    const src = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
    assert.deepEqual([...src.matchAll(/VERSION = '([^']+)'/g)].map((m) => m[1]), [PKG.version]);
    assert.equal(esm.SDK_NAME, "bfocus-monitor-node");
  });

  it("versão igual à de monitor/release.json (no monorepo)", { skip: !existsSync(RELEASE) && "espelho público" }, () => {
    assert.equal(JSON.parse(readFileSync(RELEASE, "utf8")).version, PKG.version);
  });

  it("ESM e CJS expõem a mesma API", () => {
    assert.deepEqual(Object.keys(esm).sort(), RUNTIME_EXPORTS);
    const resolved = require.resolve("@bfocus/monitor-node");
    assert.ok(resolved.endsWith(["dist", "cjs", "index.js"].join(sep)), resolved);
    const cjs = require("@bfocus/monitor-node");
    assert.deepEqual(Object.keys(cjs).filter((k) => k !== "__esModule" && k !== "default").sort(), RUNTIME_EXPORTS);
    assert.equal(cjs.VERSION, esm.VERSION);
  });

  it("o snippet do painel roda (require + init + expressErrorHandler); no init só o sinal de vida", () => {
    const code = `let calls = []; globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(null, { status: 204 }) };
const monitor = require('@bfocus/monitor-node');
const atImport = calls.length;
monitor.init({ key: 'bf_mon_x', release: process.env.APP_VERSION, environment: process.env.NODE_ENV, signingSecret: process.env.BFOCUS_SIGNING_SECRET });
const mw = monitor.expressErrorHandler();
console.log(typeof mw, mw.length, atImport, calls.join(' ')); monitor.close(10);`;
    const r = spawnSync(process.execPath, ["-e", code], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "function 4 0 https://api.bfocus.com.br/api/v1/monitor/heartbeat");
    const m = spawnSync(process.execPath, ["--input-type=module", "-e", "import { init, VERSION } from '@bfocus/monitor-node'; console.log(typeof init, VERSION)"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(m.stdout.trim(), `function ${PKG.version}`);
  });

  it("dist/cjs é CommonJS e os dois builds têm .d.ts", () => {
    assert.deepEqual(JSON.parse(readFileSync(new URL("../dist/cjs/package.json", import.meta.url), "utf8")), { type: "commonjs" });
    for (const f of ["dist/esm/index.d.ts", "dist/cjs/index.d.ts", "dist/esm/index.js", "dist/cjs/index.js"]) {
      assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
    }
  });

  it("manifesto: exports, files, engines, MIT e zero dependências de runtime", () => {
    assert.equal(PKG.name, "@bfocus/monitor-node");
    assert.equal(PKG.license, "MIT");
    assert.equal(PKG.engines.node, ">=20");
    assert.deepEqual(PKG.files, ["dist", "README.md", "LICENSE"]);
    assert.deepEqual(PKG.exports["."], {
      import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.js" },
      require: { types: "./dist/cjs/index.d.ts", default: "./dist/cjs/index.js" },
    });
    assert.equal(Object.keys(PKG.dependencies ?? {}).length, 0);
    assert.equal(Object.keys(PKG.peerDependencies ?? {}).length, 0);
    assert.ok(existsSync(new URL("../LICENSE", import.meta.url)) && existsSync(new URL("../README.md", import.meta.url)));
  });

  it("o código construído não importa nada fora do Node", () => {
    for (const f of ["client", "engine", "index", "integrations", "sign", "stack", "version"]) {
      const src = readFileSync(new URL(`../dist/esm/${f}.js`, import.meta.url), "utf8");
      for (const m of src.matchAll(/^(?:import|export)\b[^\n]*from ['"]([^'"]+)['"]/gm)) {
        assert.ok(m[1]!.startsWith("./") || m[1]!.startsWith("node:"), `${f}.js importa ${m[1]}`);
      }
    }
  });
});
