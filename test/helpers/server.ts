/**
 * Servidor HTTP local (node:http) que grava cada requisição e responde a fila de respostas do teste.
 * Sinais de vida (`/heartbeat`) ficam à parte (`heartbeats`, respostas em `heartbeatReplies`,
 * padrão 204): `requests` só tem os envios de eventos.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  /** Caminho sem a query. */
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  body: any;
}

export interface Reply {
  status: number;
  body?: unknown;
}

export interface TestServer {
  url: string;
  requests: Recorded[];
  /** Respostas na ordem; acabou a fila → 202 {"accepted": 1}. */
  replies: Reply[];
  heartbeats: Recorded[];
  /** Respostas dos sinais de vida; acabou a fila → 204. */
  heartbeatReplies: Reply[];
  /** Espera chegarem `n` requisições (ou o tempo acabar). */
  waitFor(n: number, ms?: number): Promise<void>;
  waitForHeartbeats(n: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const requests: Recorded[] = [];
  const replies: Reply[] = [];
  const heartbeats: Recorded[] = [];
  const heartbeatReplies: Reply[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawUrl = req.url ?? "/";
      const q = rawUrl.indexOf("?");
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }
      const rec: Recorded = {
        method: req.method ?? "",
        path: q === -1 ? rawUrl : rawUrl.slice(0, q),
        query: Object.fromEntries(new URLSearchParams(q === -1 ? "" : rawUrl.slice(q + 1))),
        headers: req.headers,
        rawBody,
        body,
      };
      const isHeartbeat = rec.path.endsWith("/heartbeat");
      (isHeartbeat ? heartbeats : requests).push(rec);
      const reply = isHeartbeat
        ? heartbeatReplies.shift() ?? { status: 204 }
        : replies.shift() ?? { status: 202, body: { accepted: 1 } };
      if (reply.body === undefined) res.writeHead(reply.status).end();
      else res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    replies,
    heartbeats,
    heartbeatReplies,
    async waitFor(n, ms = 3000) {
      const end = Date.now() + ms;
      while (requests.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    },
    async waitForHeartbeats(n, ms = 3000) {
      const end = Date.now() + ms;
      while (heartbeats.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Uma porta livre em que ninguém escuta (conexão recusada). */
export async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Valor por caminho com ponto: "breadcrumbs.0.category". */
export function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
