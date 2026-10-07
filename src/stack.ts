/** Rastro do V8 (de dentro para fora) → frames do contrato (de fora para dentro). */
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Frame } from './engine.js'

// "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)", "    at new X (file:1:2)"
const V8_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/
// "    at fn (native)", "    at fn (<anonymous>)", "    at fn (node:internal/...)" sem linha
const V8_NOLINE_RE = /^\s*at (.+?) \(([^()]+)\)\s*$/

function ownDir(): string {
  // De onde este arquivo foi carregado (dist/esm ou dist/cjs) — sem __dirname nem import.meta,
  // para o mesmo código servir aos dois builds. Os frames do próprio pacote não são do sistema.
  try {
    const line = (new Error().stack || '').split('\n').find((l) => V8_RE.test(l))
    const m = line ? V8_RE.exec(line) : null
    if (!m || !m[2]) return ''
    const file = m[2].startsWith('file://') ? fileURLToPath(m[2]) : m[2]
    return dirname(dirname(file)) + sep // .../dist/
  } catch {
    return ''
  }
}

const OWN_DIR = ownDir()

export interface ParseOptions {
  cwd?: string
  /** Caminhos que SÃO do sistema mesmo quando a heurística diria que não (ex.: pacote do monorepo). */
  inAppPrefixes?: string[]
}

function isLibrary(file: string): boolean {
  return (
    file.startsWith('node:') ||
    file.startsWith('internal/') ||
    /[\\/]node_modules[\\/]/.test(file) ||
    file.startsWith('node_modules/') ||
    file === 'native' ||
    file === '<anonymous>' ||
    (OWN_DIR !== '' && file.startsWith(OWN_DIR))
  )
}

export function parseStack(stack: string | undefined, opts: ParseOptions = {}): Frame[] {
  if (!stack) return []
  let cwd = opts.cwd
  if (cwd === undefined) {
    try { cwd = process.cwd() } catch { cwd = '' }
  }
  const prefix = cwd ? (cwd.endsWith(sep) ? cwd : cwd + sep) : ''
  const frames: Frame[] = []
  for (const raw of stack.split('\n').slice(0, 100)) {
    let fn: string | undefined
    let file: string
    let line: number | undefined
    let col: number | undefined
    const m = V8_RE.exec(raw)
    if (m && m[2]) {
      fn = m[1]
      file = m[2]
      line = Number(m[3])
      col = Number(m[4])
    } else {
      const n = V8_NOLINE_RE.exec(raw)
      if (!n || !n[2]) continue
      fn = n[1]
      file = n[2]
    }
    if (file.startsWith('file://')) {
      try { file = fileURLToPath(file) } catch { /* fica como veio */ }
    }
    const absolute = file
    let inApp = !isLibrary(absolute)
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length)
    if (!inApp && !(OWN_DIR && absolute.startsWith(OWN_DIR)) && opts.inAppPrefixes?.some((p) => file.startsWith(p) || absolute.startsWith(p))) {
      inApp = true
    }
    const name = (fn || '').replace(/^(async |new )/, '').trim() || undefined
    const frame: Frame = { file }
    if (name) frame.function = name
    if (line !== undefined && Number.isFinite(line)) frame.line = line
    if (col !== undefined && Number.isFinite(col)) frame.col = col
    frame.inApp = inApp
    frames.push(frame)
  }
  return frames.reverse()
}
