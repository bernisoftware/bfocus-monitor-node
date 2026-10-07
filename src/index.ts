/**
 * @bfocus/monitor-node — erros não tratados do seu sistema Node viram demanda no bFocus.
 *
 *   const monitor = require('@bfocus/monitor-node')
 *   monitor.init({ key: 'bf_mon_…', release: process.env.APP_VERSION, environment: process.env.NODE_ENV,
 *     signingSecret: process.env.BFOCUS_SIGNING_SECRET })
 *   app.use(monitor.expressErrorHandler())
 *
 * Contrato: monitor/BRIEF.md (no monorepo do bFocus).
 */
export {
  init,
  captureException,
  captureMessage,
  setUser,
  setTag,
  addBreadcrumb,
  flush,
  close,
  withContext,
} from './client.js'
export type { InitOptions, CaptureOptions } from './client.js'
export { expressRequestHandler, expressErrorHandler, fastifyMonitor, withMonitor } from './integrations.js'
export type { ErrorHandlerOptions } from './integrations.js'
export { signUserHash } from './sign.js'
export { parseStack } from './stack.js'
export type { ParseOptions } from './stack.js'
export { VERSION, SDK_NAME } from './version.js'
export type { Level, Frame, MonitorEvent, Breadcrumb } from './engine.js'
