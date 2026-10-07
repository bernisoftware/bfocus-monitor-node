/**
 * Ganchos globais em processos Node de verdade: o erro chega ao bFocus E o processo termina
 * exatamente como terminaria sem o monitor.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { startServer, type TestServer } from "./helpers/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let server: TestServer;

before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

function run(code: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const prelude = `const monitor = require('@bfocus/monitor-node');
monitor.init({ key: 'bf_mon_hooks', release: '9.9.9', baseUrl: process.env.BF_URL });
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", prelude + code], { cwd: ROOT, env: { ...process.env, BF_URL: server.url } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function lastEvents(n: number) {
  return server.requests.slice(-n).flatMap((r) => r.body.events);
}

describe("ganchos do processo", () => {
  it("uncaughtException: evento fatal, imprime o erro e sai com 1", async () => {
    const before = server.requests.length;
    const r = await run("setTimeout(() => { throw new TypeError('kaboom') }, 5)");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TypeError: kaboom/);
    assert.match(r.stderr, /Node\.js v/);
    assert.equal(server.requests.length, before + 1);
    const [ev] = lastEvents(1);
    assert.equal(ev.level, "fatal");
    assert.equal(ev.exception.type, "TypeError");
    assert.equal(ev.release, "9.9.9");
    assert.equal(server.requests.at(-1)!.headers["x-bfocus-monitor-key"], "bf_mon_hooks");
  });

  it("unhandledRejection: o processo cai como cairia sem o monitor (modo padrão)", async () => {
    const before = server.requests.length;
    const r = await run("Promise.reject(new RangeError('rejeitada'))");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RangeError: rejeitada/);
    assert.equal(server.requests.length, before + 1);
    const evs = lastEvents(1);
    assert.equal(evs.length, 1, "uma vez só, não duas");
    assert.equal(evs[0].level, "fatal");
    assert.equal(evs[0].exception.type, "RangeError");
  });

  it("rejeição com valor que não é Error", async () => {
    const before = server.requests.length;
    const r = await run("Promise.reject('só texto')");
    assert.equal(r.status, 1);
    assert.equal(server.requests.length, before + 1);
    const [ev] = lastEvents(1);
    assert.equal(ev.exception.type, "UnhandledRejection");
    assert.equal(ev.exception.message, "só texto");
  });

  it("--unhandled-rejections=warn: só captura, o processo segue", async () => {
    const before = server.requests.length;
    const r = await new Promise<{ status: number | null }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--unhandled-rejections=warn", "-e", `const m = require('@bfocus/monitor-node'); m.init({ key: 'k', baseUrl: process.env.BF_URL }); Promise.reject(new Error('aviso')); setTimeout(() => {}, 50)`],
        { cwd: ROOT, env: { ...process.env, BF_URL: server.url }, stdio: "ignore" },
      );
      child.on("close", (status) => resolve({ status }));
    });
    assert.equal(r.status, 0);
    assert.equal(server.requests.length, before + 1);
    assert.equal(lastEvents(1)[0].level, "error");
  });

  it("com outro listener de uncaughtException, quem decide é ele", async () => {
    const before = server.requests.length;
    const r = await run("process.on('uncaughtException', () => console.log('meu handler')); setTimeout(() => { throw new Error('tratado') }, 5)");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /meu handler/);
    assert.equal(server.requests.length, before + 1);
  });

  it("beforeExit: o que ficou na fila sai antes de o processo terminar", async () => {
    const before = server.requests.length;
    const r = await run("monitor.captureMessage('tchau', 'warning')");
    assert.equal(r.status, 0);
    assert.equal(server.requests.length, before + 1);
    assert.equal(lastEvents(1)[0].exception.message, "tchau");
  });

  it("autoCapture false não instala nada", async () => {
    const before = server.requests.length;
    const r = await new Promise<{ status: number | null }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["-e", `const m = require('@bfocus/monitor-node'); m.init({ key: 'k', baseUrl: process.env.BF_URL, autoCapture: false }); if (process.listenerCount('uncaughtException')) process.exit(5); throw new Error('x')`],
        { cwd: ROOT, env: { ...process.env, BF_URL: server.url }, stdio: "ignore" },
      );
      child.on("close", (status) => resolve({ status }));
    });
    assert.equal(r.status, 1);
    assert.equal(server.requests.length, before);
  });
});
