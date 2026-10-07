/**
 * Conformidade (monitor/BRIEF.md §8): roda TODOS os casos de test/cases.json — cópia de
 * monitor/conformance/cases.json escrita por `python3 monitor/conformance/generate.py` — contra
 * um servidor HTTP local que confere método, caminho, headers e os campos do evento, responde o
 * status do caso e confere o depois ("disabled" = a captura seguinte não gera requisição).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import * as monitor from "@bfocus/monitor-node";
import { getPath, sleep, startServer, type TestServer } from "./helpers/server.js";

const CASES_URL = new URL("../test/cases.json", import.meta.url);
const SOURCE_URL = new URL("../../conformance/cases.json", import.meta.url);
const CASES = JSON.parse(readFileSync(CASES_URL, "utf8"));

interface Capture {
  kind: "exception" | "message";
  type?: string;
  message: string;
  level?: monitor.Level;
  tags?: Record<string, string>;
  fingerprint?: string[];
}

function doCapture(c: Capture): void {
  if (c.kind === "message") {
    monitor.captureMessage(c.message, c.level);
    return;
  }
  const err = new Error(c.message);
  err.name = c.type ?? "Error";
  monitor.captureException(err, { level: c.level, tags: c.tags, fingerprint: c.fingerprint });
}

describe("cases.json", () => {
  it("a cópia é igual à fonte (no monorepo)", { skip: !existsSync(SOURCE_URL) && "espelho público: só a cópia existe" }, () => {
    assert.equal(readFileSync(CASES_URL, "utf8"), readFileSync(SOURCE_URL, "utf8"));
  });

  for (const v of CASES.user_hash) {
    it(`user_hash: ${v.user_external_id} / ${v.customer_external_id} @ ${v.ts}`, () => {
      assert.equal(monitor.signUserHash(v.secret, v.user_external_id, v.customer_external_id, v.ts), v.expected);
    });
  }

  for (const f of CASES.frames) {
    it(`frames: ${f.name}`, () => {
      // Rastro neutro → rastro do V8 (de dentro para fora). Biblioteca em JS mora em node_modules.
      const toNode = (file: string) => file.replace("site-packages", "node_modules");
      const cwd = "/srv/app";
      const abs = (file: string) => (file.startsWith("/") ? file : `${cwd}/${file}`);
      const stack = ["Error: x", ...f.runtime_order.map((r: any) => `    at ${r.function} (${abs(toNode(r.file))}:${r.line}:1)`)].join("\n");
      const frames = monitor.parseStack(stack, { cwd }).map(({ col: _col, ...rest }) => rest);
      assert.deepEqual(frames, f.expected.map((e: any) => ({ ...e, file: toNode(e.file) })));
    });
  }
});

describe("send", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    mock.timers.reset();
    await monitor.close(100);
    await server?.close();
    server = null;
  });

  for (const c of CASES.send) {
    it(c.name, async () => {
      server = await startServer();
      server.replies.push(...c.requests.map((r: any) => r.respond));
      monitor.init({
        key: c.init.key,
        release: c.init.release,
        environment: c.init.environment,
        signingSecret: c.init.signing_secret,
        ignore: c.init.ignore,
        baseUrl: server.url,
        autoCapture: false,
      });
      if (c.set_user) {
        if (c.set_user.ts) mock.timers.enable({ apis: ["Date"], now: c.set_user.ts * 1000 });
        monitor.setUser(c.set_user.user_external_id, c.set_user.customer_external_id, c.set_user.user_hash);
      }
      for (const b of c.breadcrumbs ?? []) monitor.addBreadcrumb(b.category, b.message, b.level);
      for (let i = 0; i < (c.repeat ?? 1); i += 1) doCapture(c.capture);
      await monitor.flush(6000);
      await sleep(50);

      assert.equal(server.requests.length, c.requests.length, "número de requisições");
      c.requests.forEach((r: any, i: number) => {
        const got = server!.requests[i]!;
        const exp = r.expect;
        assert.equal(got.method, exp.method);
        assert.equal(got.path, exp.path);
        for (const [k, v] of Object.entries(exp.headers)) assert.equal(got.headers[k.toLowerCase()], v, k);
        for (const [k, v] of Object.entries(exp.header_prefix)) {
          assert.ok(String(got.headers[k.toLowerCase()]).startsWith(v as string), k);
        }
        assert.equal(got.headers["x-bfocus-client"], `bfocus-monitor-node/${monitor.VERSION}`);
        assert.ok(Array.isArray(got.body.events) && got.body.events.length === 1, "corpo {events: [1 evento]}");
        const event = got.body.events[0];
        for (const [path, value] of Object.entries(exp.event)) {
          assert.deepEqual(getPath(event, path), value === "$version" ? monitor.VERSION : value, path);
        }
        assert.equal(event.sdk.name, "bfocus-monitor-node");
        if (i > 0) assert.equal(got.rawBody, server!.requests[i - 1]!.rawBody, "nova tentativa com o mesmo corpo");
      });

      const before = server.requests.length;
      if (c.then_capture) {
        doCapture(c.then_capture);
        await monitor.flush(1000);
        await sleep(100);
      }
      assert.equal(server.requests.length, before, c.after === "disabled" ? "depois do 401 nada mais sai" : "nada a mais");
      if (c.after === "disabled") {
        // ...até o próximo init.
        monitor.init({ key: c.init.key, baseUrl: server.url, autoCapture: false });
        doCapture(c.then_capture);
        await monitor.flush(1000);
        assert.equal(server.requests.length, before + 1, "novo init volta a enviar");
      }
    });
  }
});

describe("heartbeat", () => {
  for (const c of CASES.heartbeat) {
    it(c.name, async () => {
      const server = await startServer();
      try {
        server.heartbeatReplies.push(c.respond);
        monitor.init({ key: c.init.key, release: c.init.release, environment: c.init.environment, baseUrl: server.url, autoCapture: false });
        await server.waitForHeartbeats(1, 2000);
        await sleep(50);
        assert.equal(server.heartbeats.length, 1, "um sinal de vida no init");
        assert.equal(server.requests.length, 0, "nenhum evento");
        const got = server.heartbeats[0]!;
        const exp = c.expect;
        assert.equal(got.method, exp.method);
        assert.equal(got.path, exp.path);
        for (const [k, v] of Object.entries(exp.headers)) assert.equal(got.headers[k.toLowerCase()], v, k);
        for (const [k, v] of Object.entries(exp.header_prefix)) assert.ok(String(got.headers[k.toLowerCase()]).startsWith(v as string), k);
        for (const [path, value] of Object.entries(exp.body)) {
          assert.deepEqual(getPath(got.body, path), value === "$version" ? monitor.VERSION : value, path);
        }
        for (const path of exp.body_present) assert.ok(getPath(got.body, path), `${path} presente`);
        assert.equal(got.body.sdk.name, "bfocus-monitor-node");
        assert.equal(typeof got.body.host, "string");
        assert.deepEqual(got.body.runtime, { name: "node", version: process.version });
      } finally {
        await monitor.close(100);
        await server.close();
      }
    });
  }
});
