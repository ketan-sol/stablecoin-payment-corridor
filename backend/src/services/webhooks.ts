import { and, eq, inArray } from 'drizzle-orm'
import type { Ctx } from '../ctx'
import type { Db } from '../db'
import { counterparties, webhookDeliveries } from '../db/schema'
import { hmac } from '../crypto'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const MAX_ATTEMPTS = 6

/** Queues a webhook for each party with an endpoint (inside the state change's transaction). */
export async function enqueueWebhooks(
  tx: Db | Tx,
  partyIds: string[],
  event: string,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const parties = await tx
    .select({ id: counterparties.id, url: counterparties.webhookUrl })
    .from(counterparties)
    .where(inArray(counterparties.id, partyIds))
  const withUrl = parties.filter((p) => p.url)
  if (!withUrl.length) return []
  const rows = await tx
    .insert(webhookDeliveries)
    .values(withUrl.map((p) => ({ counterpartyId: p.id, event, payload })))
    .returning({ id: webhookDeliveries.id })
  return rows.map((r) => r.id)
}

/**
 * Delivers one webhook. Receivers verify `X-Corridor-Signature = hex(HMAC-SHA256(secret, timestamp + "." + body))`
 * and dedupe on `X-Corridor-Delivery` (retries reuse it), so a duplicate delivery is harmless.
 */
export async function deliverWebhook(ctx: Ctx, deliveryId: string, fetchImpl: typeof fetch = fetch) {
  const [d] = await ctx.db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      status: webhookDeliveries.status,
      url: counterparties.webhookUrl,
      secret: counterparties.webhookSecret,
    })
    .from(webhookDeliveries)
    .innerJoin(counterparties, eq(counterparties.id, webhookDeliveries.counterpartyId))
    .where(eq(webhookDeliveries.id, deliveryId))
  if (!d || d.status !== 'pending' || !d.url) return

  const body = JSON.stringify({ event: d.event, data: d.payload })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  let error: string | null = null
  try {
    const res = await fetchImpl(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-corridor-delivery': d.id,
        'x-corridor-timestamp': timestamp,
        'x-corridor-signature': hmac(d.secret ?? '', `${timestamp}.${body}`),
      },
      body,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (e) {
    error = (e as Error).message
  }

  const attempts = d.attempts + 1
  if (!error) {
    await ctx.db
      .update(webhookDeliveries)
      .set({ status: 'delivered', attempts, deliveredAt: new Date(), lastError: null })
      .where(eq(webhookDeliveries.id, d.id))
    return
  }
  const failed = attempts >= MAX_ATTEMPTS
  await ctx.db
    .update(webhookDeliveries)
    .set({ status: failed ? 'failed' : 'pending', attempts, lastError: error })
    .where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, 'pending')))
  if (!failed) await ctx.queue.add('webhook', { id: d.id }, { delayMs: 1000 * 2 ** attempts, jobId: `${d.id}:${attempts}` })
}
