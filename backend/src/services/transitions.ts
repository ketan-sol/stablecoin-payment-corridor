import { and, eq } from 'drizzle-orm'
import { canTransition, STATE_LABELS, type PaymentState } from '@corridor/shared'
import type { Ctx } from '../ctx'
import type { Db } from '../db'
import { paymentEvents, payments } from '../db/schema'
import { enqueueWebhooks } from './webhooks'

export type Payment = typeof payments.$inferSelect
export type PaymentPatch = Partial<typeof payments.$inferInsert>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export class IllegalTransition extends Error {}

/**
 * The only way a payment changes state. One database transaction: compare-and-set on the current state (so two
 * workers or a retried job can never both move it), the audit-log line, the ledger entry, and the webhooks.
 * Returns the updated row, or null if the payment had already moved (an idempotent no-op).
 */
export async function transition(
  ctx: Ctx,
  p: Payment,
  to: PaymentState,
  opts: {
    actor: string
    reason?: string
    patch?: PaymentPatch
    data?: Record<string, unknown>
    ledger?: (tx: Tx, updated: Payment) => Promise<unknown>
  },
): Promise<Payment | null> {
  const from = p.state as PaymentState
  if (!canTransition(from, to)) throw new IllegalTransition(`${from} → ${to} is not allowed`)
  const deliveries: string[] = []
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(payments)
      .set({ ...opts.patch, state: to, lastError: null, updatedAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.state, from)))
      .returning()
    if (!row) return null
    await tx.insert(paymentEvents).values({
      paymentId: p.id,
      fromState: from,
      toState: to,
      actor: opts.actor,
      reason: opts.reason ?? null,
      data: opts.data ?? null,
    })
    if (opts.ledger) await opts.ledger(tx, row)
    deliveries.push(
      ...(await enqueueWebhooks(tx, [row.businessId, row.supplierId], `payment.${to.toLowerCase()}`, webhookPayload(row))),
    )
    return row
  })
  for (const id of deliveries) await ctx.queue.add('webhook', { id }, { jobId: id })
  if (updated) ctx.log('payment state', { id: p.id, from, to, reason: opts.reason })
  return updated
}

/** Saves progress inside a state (a sent transaction, an error) without changing it; no-op if the state moved. */
export async function savePatch(ctx: Ctx, p: Payment, patch: PaymentPatch): Promise<Payment | null> {
  const [row] = await ctx.db
    .update(payments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(payments.id, p.id), eq(payments.state, p.state)))
    .returning()
  return row ?? null
}

export function webhookPayload(p: Payment) {
  return {
    id: p.id,
    paymentId: p.paymentId,
    state: p.state,
    label: STATE_LABELS[p.state as PaymentState],
    invoiceRef: p.invoiceRef,
    amount: p.amount.toString(),
    net: p.net.toString(),
    payoutCurrency: p.payoutCurrency,
    payoutAmount: p.payoutAmount,
    txs: { pay: p.payTx, receive: p.receiveTx, release: p.releaseTx, refund: p.refundTx },
  }
}
