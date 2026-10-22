import { randomUUID } from 'node:crypto'
import type { Address, Hex } from 'viem'
import type { Ctx } from '../ctx'
import type { payments, counterparties } from '../db/schema'

type Payment = typeof payments.$inferSelect
type Counterparty = typeof counterparties.$inferSelect

export type PayoutStatus = 'pending' | 'settled' | 'failed'

/** The plan's common payout interface: quote / send / status. */
export interface PayoutAdapter {
  readonly method: 'wallet' | 'bank'
  quote(p: Payment): { feeUsd: string; etaSeconds: number }
  /** Starts the payout; returns a reference to poll. */
  send(ctx: Ctx, p: Payment, supplier: Counterparty): Promise<{ ref: string; releaseTx?: Hex }>
  status(ctx: Ctx, p: Payment, supplier: Counterparty): Promise<PayoutStatus>
}

/** USDC straight to the supplier's wallet: the escrow release is the payout. */
export const walletPayout: PayoutAdapter = {
  method: 'wallet',
  quote: () => ({ feeUsd: '0.00', etaSeconds: 10 }),
  async send(ctx, p, supplier) {
    const releaseTx = await ctx.gw.release(p.escrowKey as Hex, supplier.wallet as Address)
    return { ref: releaseTx, releaseTx }
  },
  async status(ctx, p) {
    const r = await ctx.gw.receipt('settlement', p.payoutRef as Hex)
    if (r.status === 'pending') return 'pending'
    return r.status === 'success' ? 'settled' : 'failed'
  },
}

/**
 * Mock bank off-ramp: pays the supplier in local currency from its own float, then is reimbursed by an escrow release
 * to its approved off-ramp address. Stateless, so restarts don't lose transfers: the reference carries the send time,
 * a transfer settles after BANK_SETTLE_MS, and accounts starting with "FAIL" bounce (the demo's off-ramp failure).
 */
export const mockBank: PayoutAdapter = {
  method: 'bank',
  quote: () => ({ feeUsd: '1.00', etaSeconds: 60 }),
  async send(ctx, p, supplier) {
    if (!supplier.bankAccount) throw new Error('supplier has no bank account on file')
    return { ref: `bank_${Date.now()}_${randomUUID()}` }
  },
  async status(ctx, p, supplier) {
    const sentAt = Number(p.payoutRef?.split('_')[1] ?? 0)
    if (Date.now() - sentAt < ctx.cfg.env.BANK_SETTLE_MS) return 'pending'
    return supplier.bankAccount?.accountNumber.toUpperCase().startsWith('FAIL') ? 'failed' : 'settled'
  },
}

export const adapterFor = (method: string): PayoutAdapter => (method === 'bank' ? mockBank : walletPayout)
