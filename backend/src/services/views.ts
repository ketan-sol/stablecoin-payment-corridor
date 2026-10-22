import { asc, eq, inArray } from 'drizzle-orm'
import type { Address, Hex } from 'viem'
import { STATE_LABELS, type PaymentState, type PaymentView, type PublicConfig, type TxLink } from '@corridor/shared'
import type { Ctx } from '../ctx'
import { counterparties, paymentEvents, quotes } from '../db/schema'
import { PAYOUT_CURRENCIES } from './fx'
import type { Payment } from './transitions'

export function publicConfig(ctx: Ctx): PublicConfig {
  const n = ctx.cfg.network
  return {
    network: n.kind,
    settlement: { ...n.settlement },
    sources: Object.values(n.sources).map((s) => ({ ...s })),
    payoutCurrencies: PAYOUT_CURRENCIES,
    quoteTtlSec: ctx.cfg.env.QUOTE_TTL_SEC,
  }
}

function txLinks(ctx: Ctx, p: Payment): TxLink[] {
  const n = ctx.cfg.network
  const src = n.sources[p.sourceChain]
  const link = (label: string, chain: 'source' | 'settlement', hash: string | null): TxLink | null => {
    if (!hash || !hash.startsWith('0x')) return null
    const explorer = chain === 'source' ? src.explorer : n.settlement.explorer
    return {
      label,
      chain: chain === 'source' ? src.name : n.settlement.name,
      hash: hash as Hex,
      url: explorer ? `${explorer}/tx/${hash}` : null,
    }
  }
  return [
    link('Funds sent', 'source', p.payTx),
    link('Minted into escrow', 'settlement', p.receiveTx),
    link('Held for compliance', 'settlement', p.freezeTx),
    link('Released to supplier', 'settlement', p.releaseTx),
    link('Refunded', 'settlement', p.refundTx),
  ].filter((x): x is TxLink => x !== null)
}

export async function paymentViews(ctx: Ctx, rows: Payment[]): Promise<PaymentView[]> {
  if (!rows.length) return []
  const ids = [...new Set(rows.flatMap((p) => [p.businessId, p.supplierId]))]
  const parties = new Map((await ctx.db.select().from(counterparties).where(inArray(counterparties.id, ids))).map((c) => [c.id, c]))
  const events = await ctx.db
    .select()
    .from(paymentEvents)
    .where(inArray(paymentEvents.paymentId, rows.map((p) => p.id)))
    .orderBy(asc(paymentEvents.id))
  const quoteIds = rows.flatMap((p) => (p.state === 'QUOTED' && p.quoteId ? [p.quoteId] : []))
  const expiry = new Map(
    quoteIds.length
      ? (await ctx.db.select().from(quotes).where(inArray(quotes.id, quoteIds))).map((q) => [q.id, q.expiresAt])
      : [],
  )
  const label = (p: Payment) => {
    const expiresAt = p.state === 'QUOTED' && p.quoteId ? expiry.get(p.quoteId) : undefined
    return expiresAt && expiresAt.getTime() < Date.now() ? 'Quote expired' : STATE_LABELS[p.state as PaymentState]
  }
  return rows.map((p) => ({
    id: p.id,
    paymentId: p.paymentId as Hex,
    batchId: p.batchId,
    state: p.state as PaymentState,
    label: label(p),
    business: { id: p.businessId, name: parties.get(p.businessId)?.name ?? '?' },
    supplier: { id: p.supplierId, name: parties.get(p.supplierId)?.name ?? '?' },
    sourceChain: p.sourceChain,
    amountUsd: p.amountUsd,
    amount: p.amount.toString(),
    fee: p.fee.toString(),
    net: (p.received ?? p.net).toString(),
    payoutCurrency: p.payoutCurrency,
    payoutAmount: p.payoutAmount,
    invoiceRef: p.invoiceRef,
    refundTo: p.refundTo as Address,
    escrowKey: (p.escrowKey as Hex) ?? null,
    refundAvailable: p.state === 'REFUNDED' && !p.refundWithdrawTx,
    lastError: p.lastError,
    txs: txLinks(ctx, p),
    events: events
      .filter((e) => e.paymentId === p.id)
      .map((e) => ({
        at: e.createdAt.toISOString(),
        from: (e.fromState as PaymentState) ?? null,
        to: e.toState as PaymentState,
        label: STATE_LABELS[e.toState as PaymentState],
        actor: e.actor,
        reason: e.reason,
      })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }))
}

export async function paymentView(ctx: Ctx, p: Payment) {
  return (await paymentViews(ctx, [p]))[0]
}

export { eq }
