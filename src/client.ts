/**
 * O monitor do processo (singleton), os ganchos globais do Node e o contexto por requisição.
 *
 * - `uncaughtException`: captura com level `fatal`, faz flush com teto de 2 s e depois reproduz
 *   o comportamento padrão do Node (imprime o erro e sai com código 1) — só quando não há outro
 *   listener; havendo, quem decide é ele.
 * - `unhandledRejection`: no modo padrão do Node (`throw`) e sem outro listener, a rejeição vira
 *   exceção não tratada, como sem o monitor (o processo cai). Nos outros modos, só captura.
 * - `beforeExit`: esvazia a fila.
 * - Sinal de vida (§7b): no `init` e a cada 5 min (timer `unref`: não segura o processo).
 * - Contexto por requisição com AsyncLocalStorage: dois usuários simultâneos nunca trocam de
 *   identidade (BRIEF §6).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { inspect } from 'node:util'
import {
  Engine,
  newScope,
  pushBreadcrumb,
  setScopeTag,
  toException,
  type Level,
  type MonitorEvent,
  type Scope,
} from './engine.js'
import { RESIGN_AFTER_SECONDS, signUserHash } from './sign.js'
import { parseStack } from './stack.js'
import { SDK_NAME, VERSION } from './version.js'

export interface InitOptions {
  /** Chave do agente (`bf_mon_…`). Obrigatória. */
  key: string
  /** Versão do seu sistema (`1.4.2`). */
  release?: string
  /** Padrão `production`. */
  environment?: string
  /** Padrão `https://api.bfocus.com.br`. */
  baseUrl?: string
  /** 0..1 — fração dos erros enviada (padrão 1). */
  sampleRate?: number
  /** Mensagens a ignorar (texto contido ou RegExp). */
  ignore?: (string | RegExp)[]
  /** Última chance de mudar ou descartar (devolva null) o evento. */
  beforeSend?: (event: MonitorEvent) => MonitorEvent | null | undefined
  /** Segredo da chave de assinatura do sistema: com ele, `setUser` assina a identidade sozinho. */
  signingSecret?: string
  /** Instalar os ganchos globais (padrão true). */
  autoCapture?: boolean
  /** Caminhos que são do seu sistema mesmo dentro de node_modules (ex.: pacotes do monorepo). */
  inAppPrefixes?: string[]
}

export interface CaptureOptions {
  level?: Level
  tags?: Record<string, string>
  fingerprint?: string[]
}

const storage = new AsyncLocalStorage<Scope>()
let engine: Engine | null = null
let options: InitOptions | null = null
let globalScope: Scope = newScope()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

function heartbeatInfo() {
  let host = ''
  try { host = hostname() } catch { /* ignore */ }
  const instance = createHash('sha256').update(`${host}:${process.pid}`).digest('hex').slice(0, 16)
  return { instance, host: host.slice(0, 200) || undefined, runtime: { name: 'node', version: process.version } }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

/** Rejeições que o próprio gancho relançou como exceção (já capturadas). */
const rethrown = new WeakSet<object>()

export function init(opts: InitOptions): void {
  if (!opts || typeof opts.key !== 'string' || !opts.key.trim()) {
    throw new TypeError('bFocus monitor: `key` é obrigatória (a chave do agente, bf_mon_…)')
  }
  const previous = engine
  if (previous) {
    previous.drain()
    previous.closed = true
  }
  options = { ...opts, key: opts.key.trim() }
  globalScope = newScope()
  engine = new Engine({
    key: options.key,
    release: opts.release,
    environment: opts.environment,
    baseUrl: opts.baseUrl,
    sampleRate: opts.sampleRate,
    ignore: opts.ignore,
    beforeSend: opts.beforeSend,
    sdk: { name: SDK_NAME, version: VERSION },
    headers: { 'User-Agent': `${SDK_NAME}/${VERSION}` },
    contexts: { runtime: { name: 'node', version: process.version }, os: { name: process.platform } },
    unrefTimers: true,
  })
  if (opts.autoCapture === false) removeHooks()
  else installHooks()
  stopHeartbeat()
  try {
    const current = engine
    const info = heartbeatInfo()
    void current.heartbeat(info)
    heartbeatTimer = setInterval(() => { void current.heartbeat(info) }, HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref?.()
  } catch { /* nunca derruba o app */ }
}

function scopes(extra?: Scope): Scope[] {
  const s = extra ?? storage.getStore()
  return s && s !== globalScope ? [globalScope, s] : [globalScope]
}

function currentScope(): Scope {
  return storage.getStore() ?? globalScope
}

function refreshSignatures(list: Scope[]): void {
  const secret = options?.signingSecret
  if (!secret) return
  const now = Math.floor(Date.now() / 1000)
  for (const s of list) {
    if (s.user && s.signedAt !== undefined && now - s.signedAt > RESIGN_AFTER_SECONDS) {
      s.user = { externalId: s.user.externalId, userHash: signUserHash(secret, s.user.externalId, s.customer?.externalId ?? '', now) }
      s.signedAt = now
    }
  }
}

/** Captura com um escopo explícito (integrações). Nunca lança. */
export function captureWithScope(err: unknown, level: Level, extra: CaptureOptions, scope?: Scope, nonErrorType = 'Error'): void {
  try {
    if (!engine) return
    const exc = toException(err, (stack) => parseStack(stack, { inAppPrefixes: options?.inAppPrefixes }), nonErrorType)
    const list = scopes(scope)
    refreshSignatures(list)
    engine.capture(exc, level, list, { tags: extra.tags, fingerprint: extra.fingerprint })
  } catch { /* nunca derruba o app */ }
}

export function captureException(err: unknown, opts: CaptureOptions = {}): void {
  captureWithScope(err, opts.level ?? 'error', opts)
}

export function captureMessage(message: string, level: Level = 'info'): void {
  try {
    if (!engine) return
    const list = scopes()
    refreshSignatures(list)
    engine.capture({ type: 'Message', message: String(message), frames: [] }, level, list, { fingerprint: [String(message)] })
  } catch { /* nunca derruba o app */ }
}

/**
 * Quem foi afetado. Dentro de uma requisição (integração de framework ou `withContext`) vale só
 * para ela. Com `signingSecret` no `init`, o `userHash` é calculado aqui. Sem argumentos, limpa.
 */
export function setUser(userExternalId?: string | null, customerExternalId?: string | null, userHash?: string | null): void {
  try {
    const scope = currentScope()
    delete scope.signedAt
    if (!userExternalId) {
      delete scope.user
      delete scope.customer
      return
    }
    const user: NonNullable<Scope['user']> = { externalId: String(userExternalId) }
    const customer = customerExternalId ? String(customerExternalId) : ''
    if (userHash) {
      user.userHash = String(userHash)
    } else if (options?.signingSecret) {
      const ts = Math.floor(Date.now() / 1000)
      user.userHash = signUserHash(options.signingSecret, user.externalId, customer, ts)
      scope.signedAt = ts
    }
    scope.user = user
    if (customer) scope.customer = { externalId: customer }
    else delete scope.customer
  } catch { /* nunca derruba o app */ }
}

export function setTag(key: string, value: string): void {
  try { setScopeTag(currentScope(), key, value) } catch { /* ignore */ }
}

export function addBreadcrumb(category: string, message: string, level: Level = 'info'): void {
  try { pushBreadcrumb(currentScope(), category, message, level) } catch { /* ignore */ }
}

/** Espera o envio do que está na fila, com teto (ms). `true` = tudo saiu a tempo. */
export function flush(timeoutMs = 2000): Promise<boolean> {
  return engine ? engine.flush(timeoutMs) : Promise.resolve(true)
}

/** Esvazia a fila, desliga o envio e tira os ganchos. */
export async function close(timeoutMs = 2000): Promise<boolean> {
  removeHooks()
  stopHeartbeat()
  const e = engine
  engine = null
  return e ? e.close(timeoutMs) : true
}

/** Roda `fn` num contexto próprio (identidade, tags e passos só dele). */
export function withContext<T>(fn: () => T, init: Partial<Omit<Scope, 'tags' | 'breadcrumbs'>> = {}): T {
  return storage.run(newScope(init), fn)
}

/** Para integrações: roda `fn` dentro de `scope`. */
export function runInScope<T>(scope: Scope, fn: () => T): T {
  return storage.run(scope, fn)
}

/** Para integrações: o escopo da requisição atual (se houver). */
export function activeScope(): Scope | undefined {
  return storage.getStore()
}

// ── ganchos globais ──────────────────────────────────────────────────────────

let hooks: {
  uncaught: (err: unknown) => void
  rejection: (reason: unknown) => void
  beforeExit: () => void
} | null = null
let dying = false

function rejectionMode(): string {
  const args = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)]
  for (const a of args) {
    const m = /^--unhandled-rejections=(\S+)$/.exec(a)
    if (m && m[1]) return m[1]
  }
  return 'throw'
}

function unhandledRejectionError(reason: unknown): Error {
  const err = new Error(
    'This error originated either by throwing inside of an async function without a catch block, ' +
      `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(reason)}".`,
  )
  err.name = 'UnhandledPromiseRejection'
  ;(err as Error & { code?: string }).code = 'ERR_UNHANDLED_REJECTION'
  return err
}

function installHooks(): void {
  if (hooks) return
  const uncaught = (err: unknown) => {
    if (!(err && typeof err === 'object' && rethrown.has(err))) captureWithScope(err, 'fatal', {})
    if (process.listenerCount('uncaughtException') > 1) {
      void flush(2000)
      return // outro listener decide o destino do processo
    }
    if (dying) return
    dying = true
    const die = () => {
      // O que o Node imprime sozinho numa exceção não tratada.
      try { process.stderr.write(`${inspect(err)}\n\nNode.js ${process.version}\n`) } catch { /* ignore */ }
      process.exit(1)
    }
    flush(2000).then(die, die)
  }
  const rejection = (reason: unknown) => {
    const alone = process.listenerCount('unhandledRejection') <= 1
    const mode = rejectionMode()
    if (alone && mode === 'throw') {
      captureWithScope(reason, 'fatal', {}, undefined, 'UnhandledRejection')
      const error = reason instanceof Error ? reason : unhandledRejectionError(reason)
      rethrown.add(error)
      throw error // como o Node faria sem listener: vira exceção não tratada
    }
    captureWithScope(reason, 'error', {}, undefined, 'UnhandledRejection')
    if (alone && (mode === 'warn' || mode === 'warn-with-error-code')) {
      try { process.emitWarning(unhandledRejectionError(reason).message, 'UnhandledPromiseRejectionWarning') } catch { /* ignore */ }
      if (mode === 'warn-with-error-code') process.exitCode = 1
    }
  }
  const beforeExit = () => {
    if (engine && engine.pending()) void engine.flush(2000)
  }
  process.on('uncaughtException', uncaught)
  process.on('unhandledRejection', rejection)
  process.on('beforeExit', beforeExit)
  hooks = { uncaught, rejection, beforeExit }
}

function removeHooks(): void {
  if (!hooks) return
  process.removeListener('uncaughtException', hooks.uncaught)
  process.removeListener('unhandledRejection', hooks.rejection)
  process.removeListener('beforeExit', hooks.beforeExit)
  hooks = null
}
