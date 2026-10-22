import { eq } from 'drizzle-orm'
import type { Address, Hex } from 'viem'
import type { PaymentState } from '@corridor/shared'
import type { Ctx } from '../src/ctx'
import { journalLines, payments } from '../src/db/schema'
import { balances } from '../src/ledger'
import { onboard } from '../src/services/counterparties'
import { batchIntentFor, batchTypedDataFor, typedDataFor } from '../src/services/intents'
import { advance } from '../src/services/orchestrator'
import { createBatch, createPayment, quotePayment, signBatch, signPayment } from '../src/services/quote'
import { business, supplier2Wallet, supplierWallet } from './fakes'

export async function seed(ctx: Ctx, opts: { supplierName?: string; payoutMethod?: 'wallet' | 'bank'; account?: string } = {}) {
  const b = await onboard(ctx, { kind: 'business', name: 'Acme Inc', country: 'US', wallet: business.address })
  const s = await onboard(ctx, {
    kind: 'supplier',
    name: opts.supplierName ?? 'Supplier Pvt Ltd',
    country: 'IN',
    wallet: supplierWallet,
    payoutMethod: opts.payoutMethod ?? 'wallet',
    bankAccount: opts.payoutMethod === 'bank' ? { bankName: 'Mock Bank', accountNumber: opts.account ?? '00012345', currency: 'INR' } : null,
  })
  return { businessId: b.id, supplierId: s.id }
}

export async function seedSecondSupplier(ctx: Ctx) {
  return (await onboard(ctx, { kind: 'supplier', name: 'Second Supplier', country: 'MX', wallet: supplier2Wallet })).id
}

export async function load(ctx: Ctx, id: string) {
  const [p] = await ctx.db.select().from(payments).where(eq(payments.id, id))
  return p
}

/** Create, quote and sign one payment the way the sender app does. */
export async function signedPayment(
  ctx: Ctx,
  ids: { businessId: string; supplierId: string },
  opts: { amountUsd?: string; sourceChain?: string; payoutCurrency?: string } = {},
) {
  const p = await createPayment(ctx, {
    ...ids,
    amountUsd: opts.amountUsd ?? '1000.00',
    invoiceRef: 'INV-2026-0042',
    sourceChain: opts.sourceChain ?? 'base',
    payoutCurrency: opts.payoutCurrency ?? 'INR',
  })
  const q = await quotePayment(ctx, p.id)
  const quoted = await load(ctx, p.id)
  const typed = typedDataFor(ctx.cfg, quoted, business.address, supplierWallet)
  const signature = await business.signTypedData(typed as Parameters<typeof business.signTypedData>[0])
  await signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature })
  return p.id
}

export async function signedBatch(ctx: Ctx, businessId: string, supplierIds: string[]) {
  const b = await createBatch(ctx, {
    businessId,
    sourceChain: 'base',
    payoutCurrency: 'USD',
    legs: supplierIds.map((supplierId, i) => ({ supplierId, amountUsd: `${100 * (i + 1)}.00`, invoiceRef: `INV-B-${i}` })),
  })
  const legs = await Promise.all(b.payments.map((id) => load(ctx, id)))
  const receivers = legs.map((l) => (l.supplierId === supplierIds[0] ? supplierWallet : supplier2Wallet)) as Address[]
  const intent = batchIntentFor(ctx.cfg, legs.map((p, k) => ({ p, receiver: receivers[k] })), BigInt(b.fee), business.address)
  const [row] = await ctx.db.select().from((await import('../src/db/schema')).batches)
  const typed = batchTypedDataFor(ctx.cfg, 'base', intent, row.permitNonce, row.deadline)
  const signature = await business.signTypedData(typed as Parameters<typeof business.signTypedData>[0])
  await signBatch(ctx, b.batchId, { quoteToken: b.quoteToken, signature: signature as Hex })
  return b.payments
}

/** Runs the orchestrator until the payment stops moving; returns its state. */
export async function drive(ctx: Ctx, id: string): Promise<PaymentState> {
  let last: PaymentState | null = null
  for (let i = 0; i < 30; i++) {
    const s = await advance(ctx, id)
    if (s === last) return s!
    last = s
  }
  return last!
}

/** Every journal entry balances, so the whole ledger sums to zero. */
export async function ledgerSum(ctx: Ctx) {
  const lines = await ctx.db.select().from(journalLines)
  return lines.reduce((s, l) => s + l.amount, 0n)
}

export { balances }
