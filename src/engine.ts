/**
 * Motor de envio do Monitoramento do bFocus — sem dependência nenhuma e sem API de plataforma
 * (só `fetch`, `setTimeout` e `Date`). É o MESMO arquivo em `monitor/node/src/engine.ts` (fonte)
 * e `monitor/react-native/src/engine.ts` (cópia; o teste de lá confere que é igual).
 *
 * Contrato: `monitor/BRIEF.md` §4 e §5.
 * - Fila em memória limitada (100 eventos; cheia → descarta o mais novo).
 * - Lote a cada 1 s ou 20 eventos, o que vier primeiro; até 50 eventos por requisição.
 * - 429, 5xx e erro de rede → uma nova tentativa depois de 2 s; falhou de novo → descarta.
 * - 401/403 → descarta e desliga o envio até o próximo `init` (nunca martelar a API).
 *   400/413 → descarta o lote.
 * - O mesmo erro (tipo + mensagem + frame do erro) no máximo 1 vez a cada 30 s, e no máximo
 *   100 eventos por minuto.
 * - Sinal de vida (§7b): `heartbeat()` manda `POST /api/v1/monitor/heartbeat` com os mesmos
 *   headers; 401/403 desliga o envio, falha de rede é ignorada (o próximo intervalo tenta de novo).
 * - Nunca derruba o app: toda falha do monitor é engolida.
 */

export type Level = 'fatal' | 'error' | 'warning' | 'info'

export interface Frame { file?: string; function?: string; line?: number; col?: number; inApp?: boolean }

export interface Breadcrumb { timestamp: string; category: string; message: string; level: Level }

export interface MonitorEvent {
  timestamp: string
  level: Level
  release?: string
  environment?: string
  exception: { type: string; message: string; frames: Frame[] }
  transaction?: string
  url?: string
  user?: { externalId: string; userHash?: string }
  customer?: { externalId: string }
  tags?: Record<string, string>
  breadcrumbs?: Breadcrumb[]
  fingerprint?: string[]
  contexts?: Record<string, Record<string, string>>
  sdk: { name: string; version: string }
}

/** O que vai junto do erro: identidade, tags, passos, rota. Global ou por requisição. */
export interface Scope {
  user?: { externalId: string; userHash?: string }
  customer?: { externalId: string }
  /** Segundo (UTC) em que o pacote assinou o `userHash` sozinho (para renovar depois de 6 dias). */
  signedAt?: number
  tags: Record<string, string>
  breadcrumbs: Breadcrumb[]
  transaction?: string
  url?: string
}

export interface ExceptionInfo { type: string; message: string; frames: Frame[] }

export interface CaptureExtra { tags?: Record<string, string>; fingerprint?: string[] }

/** Corpo do sinal de vida (§7b), sem `release`/`environment`/`sdk`, que vêm da configuração. */
export interface HeartbeatInfo {
  /** Id estável do processo (servidor) ou do aparelho (app). */
  instance: string
  /** Só servidor. */
  host?: string
  runtime?: Record<string, string>
}

export interface EngineConfig {
  key: string
  release?: string
  environment?: string
  baseUrl?: string
  sampleRate?: number
  ignore?: (string | RegExp)[]
  beforeSend?: (event: MonitorEvent) => MonitorEvent | null | undefined
  sdk: { name: string; version: string }
  /** Headers a mais (ex.: User-Agent no Node). */
  headers?: Record<string, string>
  contexts?: Record<string, Record<string, string>>
  /** Node: o timer do lote não segura o processo vivo (o `beforeExit` esvazia a fila). */
  unrefTimers?: boolean
}

export const DEFAULT_BASE_URL = 'https://api.bfocus.com.br'
export const EVENTS_PATH = '/api/v1/monitor/events'
export const HEARTBEAT_PATH = '/api/v1/monitor/heartbeat'
export const QUEUE_MAX = 100
export const BATCH_EVENTS = 20
export const BATCH_MAX = 50
export const FLUSH_MS = 1000
export const RETRY_MS = 2000
export const DEDUPE_MS = 30_000
export const RATE_PER_MINUTE = 100
export const MAX_EVENT_BYTES = 64 * 1024
export const MAX_BREADCRUMBS = 30
export const MAX_FRAMES = 60
export const MAX_MESSAGE = 2000
const REQUEST_TIMEOUT_MS = 10_000

export function newScope(init: Partial<Scope> = {}): Scope {
  return { tags: {}, breadcrumbs: [], ...init }
}

export function pushBreadcrumb(scope: Scope, category: string, message: string, level: Level = 'info'): void {
  scope.breadcrumbs.push({
    timestamp: new Date().toISOString(),
    category: String(category).slice(0, 64),
    message: String(message).slice(0, 300),
    level,
  })
  if (scope.breadcrumbs.length > MAX_BREADCRUMBS) scope.breadcrumbs.shift()
}

export function setScopeTag(scope: Scope, key: string, value: string): void {
  scope.tags[String(key).slice(0, 64)] = String(value).slice(0, 200)
}

function errorType(err: Error): string {
  const name = typeof err.name === 'string' && err.name ? err.name : ''
  const ctor = (err as { constructor?: { name?: string } }).constructor?.name
  if (name && name !== 'Error') return name
  return ctor && ctor !== 'Object' ? ctor : name || 'Error'
}

function safeMessage(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const s = JSON.stringify(value)
    if (typeof s === 'string') return s.slice(0, 500)
  } catch { /* circular */ }
  try { return String(value) } catch { return 'Unknown error' }
}

/**
 * Qualquer valor lançado → exceção do contrato. Exceção encadeada (`cause`): a mais INTERNA (a
 * causa raiz) vai como exceção — tipo e mensagem dela — e a mensagem ganha
 * `" (dentro de: <TipoExterno>: <msg externa>)"` (só o tipo, se a externa já contém a interna).
 * O grupo é da causa raiz.
 */
export function toException(err: unknown, parse: (stack: string | undefined) => Frame[], nonErrorType = 'Error'): ExceptionInfo {
  if (!(err instanceof Error) && !(err && typeof err === 'object' && 'stack' in err && 'message' in err)) {
    return { type: nonErrorType, message: safeMessage(err), frames: [] }
  }
  const outer = err as Error
  let root: Error = outer
  for (let i = 0; i < 5; i += 1) {
    const cause = (root as { cause?: unknown }).cause
    if (!(cause instanceof Error) || cause === root || cause === outer) break
    root = cause
  }
  const outerMessage = typeof outer.message === 'string' ? outer.message : safeMessage(outer.message)
  if (root === outer) return { type: errorType(outer), message: outerMessage, frames: parse(outer.stack) }
  const rootMessage = typeof root.message === 'string' ? root.message : safeMessage(root.message)
  const outerType = errorType(outer)
  const where = rootMessage && outerMessage.includes(rootMessage) ? outerType : `${outerType}: ${outerMessage}`
  return {
    type: errorType(root),
    message: `${rootMessage} (dentro de: ${where})`,
    frames: parse(root.stack),
  }
}

function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1 }
    else n += 3
  }
  return n
}

function size(event: MonitorEvent): number {
  try { return utf8Length(JSON.stringify(event)) } catch { return Infinity }
}

/** Corta mensagem, frames e passos até o evento caber em 64 KB; não coube → null. */
export function fitEvent(event: MonitorEvent): MonitorEvent | null {
  if (size(event) <= MAX_EVENT_BYTES) return event
  const e: MonitorEvent = { ...event, exception: { ...event.exception } }
  const steps: (() => void)[] = [
    () => { if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.slice(-5) },
    () => { e.exception.message = e.exception.message.slice(0, 500) },
    () => { e.exception.frames = e.exception.frames.slice(-20).map((f) => ({ ...f, function: f.function?.slice(0, 200), file: f.file?.slice(0, 300) })) },
    () => { delete e.breadcrumbs; delete e.contexts },
    () => { delete e.tags },
    () => { e.exception.frames = e.exception.frames.slice(-5) },
  ]
  for (const step of steps) {
    step()
    if (size(e) <= MAX_EVENT_BYTES) return e
  }
  return null
}

function sleep(ms: number, unref: boolean): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    if (unref && t && typeof t.unref === 'function') t.unref()
  })
}

export class Engine {
  /** 401/403: parado até o próximo `init`. */
  disabled = false
  closed = false
  private readonly cfg: EngineConfig
  private readonly endpoint: string
  private readonly heartbeatEndpoint: string
  private readonly headers: Record<string, string>
  private queue: MonitorEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly inflight = new Set<Promise<void>>()
  private readonly seen = new Map<string, number>()
  private windowStart = 0
  private windowCount = 0

  constructor(cfg: EngineConfig) {
    this.cfg = cfg
    const base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.endpoint = `${base}${EVENTS_PATH}`
    this.heartbeatEndpoint = `${base}${HEARTBEAT_PATH}`
    const client = `${cfg.sdk.name}/${cfg.sdk.version}`
    this.headers = {
      'X-bFocus-Monitor-Key': cfg.key,
      'Content-Type': 'application/json',
      'X-bFocus-Client': client,
      ...(cfg.headers || {}),
    }
  }

  /** Monta o evento e põe na fila. Nunca lança. */
  capture(exc: ExceptionInfo, level: Level, scopes: Scope[], extra: CaptureExtra = {}): void {
    try {
      this.captureUnsafe(exc, level, scopes, extra)
    } catch { /* nunca derruba o app */ }
  }

  private captureUnsafe(exc: ExceptionInfo, level: Level, scopes: Scope[], extra: CaptureExtra): void {
    if (this.closed || this.disabled) return
    const message = String(exc.message ?? '')
    if ((this.cfg.ignore || []).some((p) => (typeof p === 'string' ? message.includes(p) : p.test(message)))) return
    const rate = this.cfg.sampleRate
    if (typeof rate === 'number' && rate < 1 && Math.random() >= rate) return

    const frames = exc.frames.slice(-MAX_FRAMES)
    const now = Date.now()
    const top = [...frames].reverse().find((f) => f.inApp) || frames[frames.length - 1]
    const dedupeKey = `${exc.type}|${message}|${top?.file ?? ''}:${top?.line ?? ''}`
    if ((this.seen.get(dedupeKey) ?? -Infinity) > now - DEDUPE_MS) return
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.windowCount = 0 }
    if (this.windowCount >= RATE_PER_MINUTE) return
    this.seen.set(dedupeKey, now)
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (t <= now - DEDUPE_MS) this.seen.delete(k)
    }
    this.windowCount += 1

    let user: Scope['user']
    let customer: Scope['customer']
    let transaction: string | undefined
    let url: string | undefined
    const tags: Record<string, string> = {}
    let crumbs: Breadcrumb[] = []
    for (const s of scopes) {
      if (s.user) user = s.user
      if (s.customer) customer = s.customer
      if (s.transaction) transaction = s.transaction
      if (s.url) url = s.url
      Object.assign(tags, s.tags)
      crumbs = crumbs.concat(s.breadcrumbs)
    }
    Object.assign(tags, extra.tags || {})
    crumbs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    crumbs = crumbs.slice(-MAX_BREADCRUMBS)

    let event: MonitorEvent | null | undefined = {
      timestamp: new Date(now).toISOString(),
      level,
      exception: { type: String(exc.type || 'Error').slice(0, 200), message: message.slice(0, MAX_MESSAGE), frames },
      sdk: { ...this.cfg.sdk },
    }
    if (this.cfg.release) event.release = this.cfg.release
    event.environment = this.cfg.environment || 'production'
    if (transaction) event.transaction = transaction.slice(0, 300)
    if (url) event.url = url.split('?')[0]!.split('#')[0]!.slice(0, 2000)
    if (user) event.user = user.userHash ? { externalId: user.externalId, userHash: user.userHash } : { externalId: user.externalId }
    if (customer) event.customer = { externalId: customer.externalId }
    if (Object.keys(tags).length) event.tags = tags
    if (crumbs.length) event.breadcrumbs = crumbs.map((c) => ({ ...c }))
    if (extra.fingerprint && extra.fingerprint.length) event.fingerprint = extra.fingerprint.map(String)
    if (this.cfg.contexts && Object.keys(this.cfg.contexts).length) event.contexts = this.cfg.contexts

    if (this.cfg.beforeSend) {
      try { event = this.cfg.beforeSend(event) } catch { /* beforeSend com erro: manda como está */ }
    }
    if (!event) return
    const fitted = fitEvent(event)
    if (!fitted) return
    if (this.queue.length >= QUEUE_MAX) return // fila cheia: descarta o mais novo
    this.queue.push(fitted)
    if (this.queue.length >= BATCH_EVENTS) this.drain()
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.drain() }, FLUSH_MS)
      const t = this.timer as unknown as { unref?: () => void }
      if (this.cfg.unrefTimers && t && typeof t.unref === 'function') t.unref()
    }
  }

  /** Quantos eventos esperam na fila ou no fio. */
  pending(): number {
    return this.queue.length + this.inflight.size
  }

  /** Manda tudo o que está na fila (sem esperar). */
  drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    while (this.queue.length) {
      const batch = this.queue.splice(0, BATCH_MAX)
      if (this.disabled) continue
      const p: Promise<void> = this.post(batch).catch(() => {}).then(() => { this.inflight.delete(p) })
      this.inflight.add(p)
    }
  }

  /** Esvazia a fila e espera o envio terminar, com teto. `true` = tudo saiu a tempo. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    try {
      this.drain()
      if (!this.inflight.size) return true
      let timeout: ReturnType<typeof setTimeout> | undefined
      const all = (async () => {
        while (this.inflight.size) await Promise.all([...this.inflight])
        return true
      })()
      const limit = new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs)) })
      const done = await Promise.race([all, limit])
      if (timeout) clearTimeout(timeout)
      return done
    } catch {
      return false
    }
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    const ok = await this.flush(timeoutMs)
    this.closed = true
    return ok
  }

  /** Sinal de vida. Sem nova tentativa; 401/403 desliga o envio. Nunca rejeita. */
  async heartbeat(info: HeartbeatInfo): Promise<void> {
    if (this.closed || this.disabled) return
    try {
      const body: Record<string, unknown> = { instance: info.instance }
      if (this.cfg.release) body.release = this.cfg.release
      body.environment = this.cfg.environment || 'production'
      if (info.host) body.host = info.host
      if (info.runtime) body.runtime = info.runtime
      body.sdk = { ...this.cfg.sdk }
      const status = await this.send(JSON.stringify(body), this.heartbeatEndpoint)
      if (status === 401 || status === 403) {
        this.disabled = true
        this.queue = []
      }
    } catch { /* rede: o próximo intervalo tenta de novo */ }
  }

  private async post(events: MonitorEvent[]): Promise<void> {
    const body = JSON.stringify({ events })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.disabled) return
      if (attempt > 0) await sleep(RETRY_MS, false)
      let status = 0
      try {
        status = await this.send(body)
      } catch {
        status = 0 // rede
      }
      if (status >= 200 && status < 300) return
      if (status === 401 || status === 403) {
        this.disabled = true
        this.queue = []
        return
      }
      if (status !== 0 && status !== 429 && status < 500) return // 400, 413...: descarta
    }
  }

  private async send(body: string, url: string = this.endpoint): Promise<number> {
    const f = (globalThis as { fetch?: typeof fetch }).fetch
    if (typeof f !== 'function') return 400 // sem fetch: não há como mandar, não tenta de novo
    const Ctrl = (globalThis as { AbortController?: typeof AbortController }).AbortController
    const ctrl = Ctrl ? new Ctrl() : undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    if (ctrl) {
      timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
      const t = timer as unknown as { unref?: () => void }
      if (this.cfg.unrefTimers && t && typeof t.unref === 'function') t.unref()
    }
    try {
      const res = await f(url, { method: 'POST', headers: this.headers, body, ...(ctrl ? { signal: ctrl.signal } : {}) })
      try { await res.text() } catch { /* corpo não interessa */ }
      return res.status
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
