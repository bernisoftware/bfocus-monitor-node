/** Integrações com Express e Fastify de verdade (devDependencies) e withMonitor. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import * as monitor from "@bfocus/monitor-node";
import { sleep, startServer, type TestServer } from "./helpers/server.js";

const require = createRequire(import.meta.url);
const express = require("express");
const Fastify = require("fastify");

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});
afterEach(async () => {
  await monitor.close(100);
  server.requests.length = 0;
});

const events = () => server.requests.flatMap((r) => r.body.events);

describe("express", () => {
  it("transaction com a rota, url sem query, identidade por requisição, 4xx fica de fora", async () => {
    monitor.init({ key: "k", baseUrl: server.url, autoCapture: false });
    const app = express();
    app.use(monitor.expressRequestHandler());
    app.get("/pedidos/:id", async (req: any, _res: any, next: any) => {
      monitor.setUser(`u-${req.params.id}`, "cli-1", "v2.1.abc");
      await sleep(req.params.id === "1" ? 40 : 5);
      next(new Error(`pedido ${req.params.id}`));
    });
    app.get("/nao-achou", (_req: any, _res: any, next: any) => {
      const err: any = new Error("não existe");
      err.status = 404;
      next(err);
    });
    app.use(monitor.expressErrorHandler());
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).send("erro"));
    const http = app.listen(0);
    await new Promise((r) => http.once("listening", r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    try {
      const [a, b, c] = await Promise.all([
        fetch(`${base}/pedidos/1?token=segredo`),
        fetch(`${base}/pedidos/2`),
        fetch(`${base}/nao-achou`),
      ]);
      assert.deepEqual([a.status, b.status, c.status], [500, 500, 404], "o app responde como responderia sem o monitor");
      await monitor.flush(1000);
      const byMsg = Object.fromEntries(events().map((e) => [e.exception.message, e]));
      assert.deepEqual(Object.keys(byMsg).sort(), ["pedido 1", "pedido 2"]);
      assert.equal(byMsg["pedido 1"].transaction, "GET /pedidos/:id");
      assert.equal(byMsg["pedido 1"].url, `${base}/pedidos/1`);
      assert.equal(byMsg["pedido 1"].user.externalId, "u-1");
      assert.equal(byMsg["pedido 2"].user.externalId, "u-2");
    } finally {
      await new Promise((r) => http.close(r));
    }
  });

  it("o middleware de erro tem 4 parâmetros (é assim que o Express o reconhece)", () => {
    assert.equal(monitor.expressErrorHandler().length, 4);
  });
});

describe("fastify", () => {
  it("onError captura com a rota e o contexto da requisição", async () => {
    monitor.init({ key: "k", baseUrl: server.url, autoCapture: false });
    const app = Fastify();
    await app.register(monitor.fastifyMonitor);
    app.get("/f/:id", async (req: any) => {
      monitor.setUser(`u-${req.params.id}`, "c");
      await sleep(5);
      throw new Error("falhou no fastify");
    });
    app.get("/ok", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/f/7?x=1", headers: { host: "api.cliente.com" } });
    assert.equal(res.statusCode, 500);
    const ok = await app.inject({ method: "GET", url: "/ok" });
    assert.equal(ok.statusCode, 200);
    await monitor.flush(1000);
    const [ev, ...rest] = events();
    assert.equal(rest.length, 0);
    assert.equal(ev.exception.message, "falhou no fastify");
    assert.equal(ev.transaction, "GET /f/:id");
    assert.equal(ev.url, "http://api.cliente.com/f/7");
    assert.equal(ev.user.externalId, "u-7");
    await app.close();
  });
});

describe("withMonitor", () => {
  it("captura, espera o envio e relança o mesmo erro", async () => {
    monitor.init({ key: "k", baseUrl: server.url, autoCapture: false });
    const boom = new Error("serverless");
    const handler = monitor.withMonitor(async (n: number) => {
      if (n > 1) throw boom;
      return n * 2;
    });
    assert.equal(await handler(1), 2);
    await assert.rejects(handler(2), (e) => e === boom);
    assert.equal(server.requests.length, 1, "já enviado quando o erro volta");
    assert.equal(events()[0].exception.message, "serverless");
  });
});
