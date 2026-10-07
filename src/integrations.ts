/**
 * Integrações de framework — sem importar framework nenhum (tipos mínimos locais).
 *
 * Express:  app.use(monitor.expressRequestHandler())   // antes das rotas (contexto por requisição)
 *           app.use(monitor.expressErrorHandler())     // depois das rotas
 * Fastify:  app.register(monitor.fastifyMonitor)
 * Next/serverless: export default monitor.withMonitor(handler)
 */
import { newScope, type Scope } from './engine.js'
import { activeScope, captureWithScope, flush, runInScope } from './client.js'

interface MinimalRequest {
  method?: string
  url?: string
  originalUrl?: string
  baseUrl?: string
  protocol?: string
  headers?: Record<string, string | string[] | undefined>
  route?: { path?: unknown }
  socket?: { encrypted?: boolean }
}

/** Erro "esperado" (4xx: rota inexistente, validação) não vira demanda. */
function isClientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; statusCode?: unknown; output?: { statusCode?: unknown } }
  const status = e.status ?? e.statusCode ?? e.output?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500
}

function pathOf(url: string | undefined): string {
  return String(url || '/').split('?')[0]!.split('#')[0]!
}

function fullUrl(req: MinimalRequest, path: string): string | undefined {
  const raw = req.headers?.host
  const host = Array.isArray(raw) ? raw[0] : raw
  if (!host) return undefined
  const proto = req.protocol || (req.socket?.encrypted ? 'https' : 'http')
  return `${proto}://${host}${path}`
}

function expressRoute(req: MinimalRequest): string | undefined {
  const p = req.route?.path
  return typeof p === 'string' ? `${req.baseUrl || ''}${p}` : undefined
}

function requestScope(req: MinimalRequest): Scope {
  const path = pathOf(req.originalUrl ?? req.url)
  return newScope({ transaction: `${(req.method || 'GET').toUpperCase()} ${path}`, url: fullUrl(req, path) })
}

export interface ErrorHandlerOptions {
  /** Decide se o erro vira evento. Padrão: tudo menos 4xx (`status`/`statusCode` < 500). */
  shouldHandle?: (err: unknown) => boolean
}

/**
 * Middleware Express que abre o contexto da requisição (identidade, tags e passos só dela) e
 * marca `transaction` ("METHOD /rota") e `url` (sem a query). Coloque antes das rotas.
 */
export function expressRequestHandler() {
  return function bfocusRequestHandler(req: MinimalRequest, _res: unknown, next: (err?: unknown) => void): void {
    let scope: Scope
    try {
      scope = requestScope(req)
    } catch {
      next()
      return
    }
    runInScope(scope, () => next())
  }
}

/** Middleware de erro do Express: captura e repassa (`next(err)`). Coloque depois das rotas. */
export function expressErrorHandler(opts: ErrorHandlerOptions = {}) {
  // Quatro parâmetros: é assim que o Express reconhece um middleware de erro.
  return function bfocusErrorHandler(err: unknown, req: MinimalRequest, _res: unknown, next: (err?: unknown) => void): void {
    try {
      const handle = opts.shouldHandle ? opts.shouldHandle(err) : !isClientError(err)
      if (handle) {
        const scope = activeScope() ?? requestScope(req)
        const route = expressRoute(req)
        if (route) scope.transaction = `${(req.method || 'GET').toUpperCase()} ${route}`
        captureWithScope(err, 'error', {}, scope)
      }
    } catch { /* nunca derruba o app */ }
    next(err)
  }
}

interface FastifyLike {
  addHook(name: string, fn: (...args: any[]) => unknown): unknown
}

const SCOPE = Symbol.for('bfocus.monitor.scope')

/**
 * Plugin Fastify: contexto por requisição e captura no `onError`.
 * `app.register(fastifyMonitor)` — vale para a aplicação inteira (não fica encapsulado).
 */
export function fastifyMonitor(instance: FastifyLike, _opts: unknown, done: (err?: Error) => void): void {
  instance.addHook('onRequest', (request: MinimalRequest & { routeOptions?: { url?: string }; [SCOPE]?: Scope }, _reply: unknown, next: () => void) => {
    let scope: Scope
    try {
      scope = requestScope(request)
      const route = request.routeOptions?.url
      if (route) scope.transaction = `${(request.method || 'GET').toUpperCase()} ${route}`
      request[SCOPE] = scope
    } catch {
      next()
      return
    }
    runInScope(scope, () => next())
  })
  instance.addHook('onError', (request: MinimalRequest & { [SCOPE]?: Scope }, _reply: unknown, error: unknown, next: () => void) => {
    try {
      if (!isClientError(error)) captureWithScope(error, 'error', {}, request[SCOPE] ?? activeScope() ?? requestScope(request))
    } catch { /* nunca derruba o app */ }
    next()
  })
  done()
}
// Sem encapsulamento (o que o `fastify-plugin` faz), sem depender dele.
;(fastifyMonitor as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true
;(fastifyMonitor as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'bfocus-monitor'

/**
 * Next.js (API routes, route handlers) e serverless: contexto próprio, captura, flush com teto de
 * 2 s (a função pode congelar logo depois) e relança o erro.
 */
export function withMonitor<A extends unknown[], R>(handler: (...args: A) => R | Promise<R>): (...args: A) => Promise<Awaited<R>> {
  return (...args: A) =>
    runInScope(newScope(), async (): Promise<Awaited<R>> => {
      try {
        return (await handler(...args)) as Awaited<R>
      } catch (err) {
        captureWithScope(err, 'error', {})
        await flush(2000)
        throw err
      }
    })
}
