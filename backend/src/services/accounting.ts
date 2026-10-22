import { credit, debit, post } from '../ledger'
import type { Payment, Tx } from './transitions'

/**
 * Posting rules: one balanced entry per money-moving transition, amounts in token base units.
 * Everything is USDC over CCTP.
 */
export const postings = {
  /** Source funds pulled: the fee is booked, the rest is on its way. */
  fundedSource: (tx: Tx, p: Payment, sender: string) =>
    post(tx, {
      paymentId: p.id,
      kind: 'funded_source',
      token: 'USDC',
      lines: [
        debit('in_transit', p.net),
        debit('fees', p.fee),
        credit(`sender:${sender.toLowerCase()}`, p.amount),
      ],
    }),

  /** Minted into escrow. Any shortfall is a CCTP fee. */
  escrowed: (tx: Tx, p: Payment, received: bigint) =>
    post(tx, {
      paymentId: p.id,
      kind: 'escrowed',
      token: 'USDC',
      lines: [debit('escrow', received), debit('cctp_fees', p.net - received), credit('in_transit', p.net)],
    }),

  released: (tx: Tx, p: Payment) =>
    post(tx, {
      paymentId: p.id,
      kind: 'released',
      token: 'USDC',
      lines: [debit(`payout:${p.supplierId}`, p.received ?? p.net), credit('escrow', p.received ?? p.net)],
    }),

  refunded: (tx: Tx, p: Payment) =>
    post(tx, {
      paymentId: p.id,
      kind: 'refunded',
      token: 'USDC',
      lines: [debit(`refunds:${p.refundTo.toLowerCase()}`, p.received ?? p.net), credit('escrow', p.received ?? p.net)],
    }),

  /** The refund address pulled its refund (one withdrawal can cover several refunds). */
  refundWithdrawn: (tx: Tx, account: string, amount: bigint) =>
    post(tx, {
      kind: 'refund_withdrawn',
      token: 'USDC',
      lines: [debit(`sender:${account.toLowerCase()}`, amount), credit(`refunds:${account.toLowerCase()}`, amount)],
    }),
}
