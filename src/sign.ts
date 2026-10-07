/** Identidade assinada v2 — a MESMA do widget (monitor/BRIEF.md §6). */
import { createHmac } from 'node:crypto'

/** Uma assinatura vale por 7 dias no servidor; o pacote renova depois de 6. */
export const RESIGN_AFTER_SECONDS = 6 * 24 * 3600

/**
 * `"v2." + ts + "." + hex(HMAC_SHA256(secret, "v2:" + ts + ":" + user + ":" + customer))`,
 * `ts` em segundos UTC (padrão: agora).
 */
export function signUserHash(secret: string, userExternalId: string, customerExternalId: string, ts?: number): string {
  const t = ts ?? Math.floor(Date.now() / 1000)
  const digest = createHmac('sha256', secret).update(`v2:${t}:${userExternalId}:${customerExternalId}`, 'utf8').digest('hex')
  return `v2.${t}.${digest}`
}
