/** Comportamento do monitor além dos casos de conformidade: fila, limites, contexto, rastro. */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as monitor from "@bfocus/monitor-node";
import { closedPort, sleep, startServer, type TestServer } from "./helpers/server.js";

let server: TestServer | null = null;

async function setup(opts: Partial<monitor.InitOptions> = {}) {
  server = await startServer();
  monitor.init({ key: "bf_mon_x", release: "2.0.0", baseUrl: server.url, autoCapture: false, ...opts });
  return server;
}

const events = (s: TestServer) => s.requests.flatMap((r) => r.body.events);

afterEach(async () => {
  mock.timers.reset();
  await monitor.close(100);
  await server?.close();
  server = null;
});

describe("init", () => {
  it("chave vazia é erro de argumento imediato", () => {
    assert.throws(() => monitor.init({ key: "" }), TypeError);
    assert.throws(() => monitor.init({ key: "   " }), TypeError);
    assert.throws(() => monitor.init(undefined as any), TypeError);
  });

  it("sem init, capturar não faz nada e não lança", async () => {
    monitor.captureException(new Error("x"));
    monitor.captureMessage("x");
    monitor.setUser("u", "c");
    monitor.setTag("a", "b");
    monitor.addBreadcrumb("a", "b");
    assert.equal(await monitor.flush(10), true);
  });

  it("no init só o sinal de vida; lote sai sozinho depois de ~1 s; ambiente padrão production", async () => {
    const s = await setup();
    assert.equal(s.requests.length, 0);
    monitor.captureException(new TypeError("a"));
    await sleep(300);
    assert.equal(s.requests.length, 0, "ainda no lote");
    await s.waitFor(1, 2000);
    assert.equal(s.requests.length, 1);
    const [ev] = events(s);
    assert.equal(ev.environment, "production");
    assert.equal(ev.release, "2.0.0");
    assert.equal(ev.exception.type, "TypeError");
    assert.equal(s.requests[0]!.headers["user-agent"], `bfocus-monitor-node/${monitor.VERSION}`);
    assert.equal(ev.contexts.runtime.name, "node");
    assert.equal(ev.contexts.runtime.version, process.version);
    assert.equal("transaction" in ev, false, "sem campos vazios");
    assert.equal("user" in ev, false);
  });

  it("20 eventos saem já, sem esperar o segundo", async () => {
    const s = await setup();
    for (let i = 0; i < 20; i += 1) monitor.captureMessage(`m${i}`);
    await s.waitFor(1, 500);
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.body.events.length, 20);
  });
});

describe("limites", () => {
  it("no máximo 100 eventos por minuto; lote de até 50 por requisição", async () => {
    const s = await setup();
    for (let i = 0; i < 130; i += 1) monitor.captureMessage(`msg ${i}`);
    await monitor.flush(3000);
    assert.equal(events(s).length, 100);
    assert.ok(s.requests.every((r) => r.body.events.length <= 50));
  });

  it("depois de 30 s o mesmo erro volta a sair", async () => {
    const s = await setup();
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const boom = () => monitor.captureException(new Error("igual"));
    boom();
    boom();
    mock.timers.setTime(1_000_000 + 31_000);
    boom();
    await monitor.flush(2000);
    assert.equal(events(s).length, 2);
  });

  it("sampleRate 0 não manda nada; beforeSend muda ou descarta", async () => {
    let s = await setup({ sampleRate: 0 });
    monitor.captureException(new Error("a"));
    await monitor.flush(500);
    assert.equal(s.requests.length, 0);
    await s.close();
    s = server = await startServer();
    monitor.init({
      key: "k",
      baseUrl: s.url,
      autoCapture: false,
      beforeSend: (e) => (e.exception.message === "fora" ? null : { ...e, tags: { mudado: "sim" } }),
    });
    monitor.captureException(new Error("fora"));
    monitor.captureException(new Error("dentro"));
    await monitor.flush(1000);
    assert.deepEqual(events(s).map((e) => [e.exception.message, e.tags]), [["dentro", { mudado: "sim" }]]);
  });

  it("ignore aceita RegExp", async () => {
    const s = await setup({ ignore: [/^ECONNRESET/] });
    monitor.captureException(new Error("ECONNRESET by peer"));
    await monitor.flush(500);
    assert.equal(s.requests.length, 0);
  });

  it("evento maior que 64 KB é cortado antes de sair", async () => {
    const s = await setup();
    for (let i = 0; i < 30; i += 1) monitor.addBreadcrumb("x", "y".repeat(300));
    const err = new Error("z".repeat(100_000));
    monitor.captureException(err);
    await monitor.flush(1000);
    const [ev] = events(s);
    assert.ok(Buffer.byteLength(JSON.stringify(ev)) <= 64 * 1024);
    assert.ok(ev.exception.message.length <= 2000);
  });
});

describe("envio", () => {
  it("5xx duas vezes → descarta o lote e segue enviando os próximos", async () => {
    const s = await setup();
    s.replies.push({ status: 503 }, { status: 500 });
    monitor.captureException(new Error("a"));
    await monitor.flush(5000);
    assert.equal(s.requests.length, 2);
    monitor.captureException(new Error("b"));
    await monitor.flush(1000);
    assert.equal(s.requests.length, 3);
  });

  it("403 desliga o envio; 400/413 só descartam o lote", async () => {
    const s = await setup();
    s.replies.push({ status: 400 });
    monitor.captureException(new Error("a"));
    await monitor.flush(1000);
    s.replies.push({ status: 413 });
    monitor.captureException(new Error("b"));
    await monitor.flush(1000);
    s.replies.push({ status: 403 });
    monitor.captureException(new Error("c"));
    await monitor.flush(1000);
    monitor.captureException(new Error("d"));
    await monitor.flush(1000);
    assert.deepEqual(events(s).map((e) => e.exception.message), ["a", "b", "c"]);
  });

  it("erro de rede: uma nova tentativa e nunca lança", async () => {
    const port = await closedPort();
    monitor.init({ key: "k", baseUrl: `http://127.0.0.1:${port}`, autoCapture: false });
    monitor.captureException(new Error("sem rede"));
    const t0 = Date.now();
    assert.equal(await monitor.flush(5000), true);
    assert.ok(Date.now() - t0 >= 1900, "esperou a nova tentativa");
  });

  it("flush respeita o teto", async () => {
    const s = await setup();
    s.replies.push({ status: 503 });
    monitor.captureException(new Error("a"));
    const t0 = Date.now();
    assert.equal(await monitor.flush(200), false);
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe("identidade", () => {
  it("com signingSecret renova a assinatura depois de 6 dias", async () => {
    const s = await setup({ signingSecret: "seg" });
    const t0 = 1_760_000_000;
    mock.timers.enable({ apis: ["Date"], now: t0 * 1000 });
    monitor.setUser("u1", "c1");
    monitor.captureException(new Error("a"));
    mock.timers.setTime((t0 + 7 * 86400) * 1000);
    monitor.captureException(new Error("b"));
    await monitor.flush(1000);
    const [a, b] = events(s);
    assert.equal(a.user.userHash, monitor.signUserHash("seg", "u1", "c1", t0));
    assert.equal(b.user.userHash, monitor.signUserHash("seg", "u1", "c1", t0 + 7 * 86400));
    assert.deepEqual(b.customer, { externalId: "c1" });
  });

  it("setUser() sem argumentos limpa", async () => {
    const s = await setup();
    monitor.setUser("u1", "c1", "v2.1.x");
    monitor.setUser();
    monitor.captureException(new Error("a"));
    await monitor.flush(1000);
    assert.equal(events(s)[0].user, undefined);
  });

  it("contexto por requisição: dois usuários simultâneos não trocam de identidade", async () => {
    const s = await setup();
    monitor.setTag("global", "1");
    const req = (user: string, wait: number) =>
      monitor.withContext(async () => {
        monitor.setUser(user, `cli-${user}`, `v2.1.${user}`);
        monitor.setTag("quem", user);
        await sleep(wait);
        monitor.captureException(new Error(`erro de ${user}`));
      });
    await Promise.all([req("ana", 40), req("bia", 10)]);
    monitor.captureException(new Error("fora"));
    await monitor.flush(1000);
    const byMsg = Object.fromEntries(events(s).map((e) => [e.exception.message, e]));
    assert.equal(byMsg["erro de ana"].user.externalId, "ana");
    assert.equal(byMsg["erro de ana"].customer.externalId, "cli-ana");
    assert.deepEqual(byMsg["erro de ana"].tags, { global: "1", quem: "ana" });
    assert.equal(byMsg["erro de bia"].user.externalId, "bia");
    assert.equal(byMsg["fora"].user, undefined);
    assert.deepEqual(byMsg["fora"].tags, { global: "1" });
  });
});

describe("exceção", () => {
  it("encadeada: tipo e mensagem da causa raiz, a externa vai em (dentro de: ...)", async () => {
    const s = await setup();
    class DbError extends Error {}
    const root = new DbError("conexão recusada");
    const outer = new Error("falha ao salvar pedido", { cause: new Error("repo", { cause: root }) });
    monitor.captureException(outer);
    await monitor.flush(1000);
    const ev = events(s)[0];
    assert.equal(ev.exception.type, "DbError");
    assert.equal(ev.exception.message, "conexão recusada (dentro de: Error: falha ao salvar pedido)");
  });

  it("encadeada com a mensagem externa já contendo a interna: só o tipo externo", async () => {
    const s = await setup();
    class ServicoError extends Error {}
    monitor.captureException(new ServicoError("salvar: timeout", { cause: new RangeError("timeout") }));
    await monitor.flush(1000);
    const ev = events(s)[0];
    assert.equal(ev.exception.type, "RangeError");
    assert.equal(ev.exception.message, "timeout (dentro de: ServicoError)");
  });

  it("valor que não é Error vira mensagem", async () => {
    const s = await setup();
    monitor.captureException({ code: 7 });
    monitor.captureException("texto");
    await monitor.flush(1000);
    assert.deepEqual(events(s).map((e) => [e.exception.type, e.exception.message]), [["Error", '{"code":7}'], ["Error", "texto"]]);
  });

  it("rastro real: de fora para dentro, relativo ao cwd, este arquivo é do sistema e node: não é", () => {
    function inner() {
      return new Error("x");
    }
    const frames = monitor.parseStack(inner().stack);
    const last = frames[frames.length - 1]!;
    assert.equal(last.function, "inner");
    assert.equal(last.inApp, true);
    assert.ok(last.file!.startsWith("dist-test/"), last.file);
    const internal = frames.find((f) => f.file!.startsWith("node:"));
    if (internal) assert.equal(internal.inApp, false);
  });

  it("parseStack: node_modules, file://, async, frames do próprio pacote e inAppPrefixes", () => {
    const stack = [
      "Error: x",
      "    at async handler (file:///srv/app/src/rota.js:5:3)",
      "    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)",
      "    at new Pedido (/srv/app/node_modules/@empresa/dominio/pedido.js:1:1)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      "    at Array.forEach (<anonymous>)",
    ].join("\n");
    const frames = monitor.parseStack(stack, { cwd: "/srv/app", inAppPrefixes: ["node_modules/@empresa/"] });
    assert.deepEqual(frames, [
      { file: "<anonymous>", function: "Array.forEach", inApp: false },
      { file: "node:internal/process/task_queues", function: "process.processTicksAndRejections", line: 105, col: 5, inApp: false },
      { file: "node_modules/@empresa/dominio/pedido.js", function: "Pedido", line: 1, col: 1, inApp: true },
      { file: "node_modules/express/lib/router/layer.js", function: "Layer.handle", line: 95, col: 5, inApp: false },
      { file: "src/rota.js", function: "handler", line: 5, col: 3, inApp: true },
    ]);
  });
});

describe("sinal de vida", () => {
  it("a cada 5 min, com o mesmo instance (hostname + pid); flush não manda sinal de vida", async () => {
    const s = await startServer();
    server = s;
    mock.timers.enable({ apis: ["setInterval"] });
    monitor.init({ key: "k", release: "1.0.0", baseUrl: s.url, autoCapture: false });
    await s.waitForHeartbeats(1, 2000);
    await monitor.flush(500);
    assert.equal(s.heartbeats.length, 1);
    mock.timers.tick(5 * 60 * 1000);
    await s.waitForHeartbeats(2, 2000);
    assert.equal(s.heartbeats.length, 2);
    assert.equal(s.heartbeats[0]!.body.instance, s.heartbeats[1]!.body.instance);
    assert.match(s.heartbeats[0]!.body.instance, /^[0-9a-f]{16}$/);
    await monitor.close(100);
    mock.timers.tick(5 * 60 * 1000);
    await sleep(100);
    assert.equal(s.heartbeats.length, 2, "close para o sinal de vida");
  });

  it("401 no sinal de vida desliga o envio de eventos até o próximo init", async () => {
    const s = await startServer();
    server = s;
    s.heartbeatReplies.push({ status: 401, body: { error: "MONITOR_KEY_INVALID" } });
    monitor.init({ key: "k", baseUrl: s.url, autoCapture: false });
    await s.waitForHeartbeats(1, 2000);
    await sleep(50);
    monitor.captureException(new Error("depois"));
    await monitor.flush(500);
    assert.equal(s.requests.length, 0);
  });

  it("falha de rede no sinal de vida é ignorada", async () => {
    const port = await closedPort();
    monitor.init({ key: "k", baseUrl: `http://127.0.0.1:${port}`, autoCapture: false });
    await sleep(200);
  });
});
