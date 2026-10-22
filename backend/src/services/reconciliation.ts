import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Hex } from 'viem'
import type { PaymentState } from '@corridor/shared'
import type { Ctx } from '../ctx'
import { journalEntries, journalLines, opsCases, payments, settlementReports } from '../db/schema'
import { balances } from '../ledger'
import type { EscrowStatus } from '../chain/gateway'
import { formatUnits6 } from './money'

/** What the escrow must say for each business state. */
const EXPECTED: Partial<Record<PaymentState, EscrowStatus[]>> = {
  ESCROWED: ['Escrowed'],
  COMPLIANCE_CLEARED: ['Escrowed'],
  PAYOUT_SENT: ['Escrowed', 'Released'], // release may be mined but not yet processed
  FROZEN: ['Frozen'],
  COMPLETED: ['Released'],
  REFUNDING: ['Escrowed', 'Refunded'],
  REFUNDED: ['Refunded'],
}

export interface Mismatch {
  paymentId: string | null
  title: string
  detail: Record<string, string>
}

/**
 * The plan's daily reconciliation: the ledger (business record) against the chain (settlement record).
 * Per payment: escrow status and amount match the state, and the ledger's escrow movement matches.
 * Globally: ledger escrow + unpulled refunds = the escrow's on-chain totalHeld.
 * Every mismatch opens one ops case.
 */
export async function reconcile(ctx: Ctx): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = []
  const rows = await ctx.db.select().from(payments).where(isNotNull(payments.received))
  const escrowMoves = await ctx.db
    .select({ paymentId: journalEntries.paymentId, total: sql<string>`sum(${journalLines.amount})` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalLines.account, 'escrow'))
    .groupBy(journalEntries.paymentId)
  const ledgerEscrow = new Map(escrowMoves.map((r) => [r.paymentId, BigInt(r.total)]))

  for (const p of rows) {
    const expected = EXPECTED[p.state as PaymentState]
    if (!expected || !p.escrowKey) continue
    const rec = await ctx.gw.escrowPayment(p.escrowKey as Hex)
    if (!expected.includes(rec.status)) {
      mismatches.push({ paymentId: p.id, title: `Escrow says ${rec.status}, ledger says ${p.state}`, detail: { key: p.escrowKey } })
    }
    if (rec.status !== 'None' && rec.amount !== p.received) {
      mismatches.push({
        paymentId: p.id,
        title: 'Escrowed amount differs from the ledger',
        detail: { chain: rec.amount.toString(), ledger: String(p.received) },
      })
    }
    const held = ['Escrowed', 'Frozen'].includes(rec.status)
    const ledger = ledgerEscrow.get(p.id) ?? 0n
    if (ledger !== (held ? p.received! : 0n)) {
      mismatches.push({ paymentId: p.id, title: 'Ledger escrow balance does not match escrow status', detail: { ledger: ledger.toString(), status: rec.status } })
    }
  }

  const b = await balances(ctx.db)
  const refunds = Object.entries(b)
    .filter(([a]) => a.startsWith('refunds:'))
    .reduce((s, [, v]) => s + v, 0n)
  const onChain = await ctx.gw.totalHeld(ctx.cfg.network.settlement.usdc)
  if ((b.escrow ?? 0n) + refunds !== onChain) {
    mismatches.push({
      paymentId: null,
      title: 'Escrow totalHeld differs from the ledger',
      detail: { chain: onChain.toString(), ledgerEscrow: String(b.escrow ?? 0n), ledgerRefunds: refunds.toString() },
    })
  }

  for (const m of mismatches) {
    const open = await ctx.db
      .select({ id: opsCases.id })
      .from(opsCases)
      .where(and(eq(opsCases.kind, 'reconciliation'), eq(opsCases.status, 'open'), eq(opsCases.title, m.title), m.paymentId ? eq(opsCases.paymentId, m.paymentId) : sql`${opsCases.paymentId} is null`))
    if (!open.length) await ctx.db.insert(opsCases).values({ paymentId: m.paymentId, kind: 'reconciliation', title: m.title, detail: m.detail })
  }
  return mismatches
}

/** The bank-style settlement file: one CSV per day and corridor (source → Arc → payout currency). */
export async function settlementReport(ctx: Ctx, day: string, mismatches: Mismatch[] = []) {
  const start = new Date(`${day}T00:00:00Z`)
  const end = new Date(start.getTime() + 86_400_000)
  const rows = await ctx.db.select().from(payments).where(and(gte(payments.createdAt, start), lt(payments.createdAt, end)))
  const settled = rows.filter((p) => !['CREATED', 'QUOTED'].includes(p.state))
  const bad = new Set(mismatches.map((m) => m.paymentId))
  const corridors = new Map<string, typeof settled>()
  for (const p of settled) {
    const c = `${p.sourceChain}->arc:${p.payoutCurrency}`
    corridors.set(c, [...(corridors.get(c) ?? []), p])
  }
  const out = []
  for (const [corridor, ps] of corridors) {
    const header = 'payment_id,invoice_ref,state,gross_usd,fee_usd,net_usd,payout_currency,payout_amount,pay_tx,release_tx,refund_tx'
    const lines = ps.map((p) =>
      [p.paymentId, p.invoiceRef, p.state, formatUnits6(p.amount), formatUnits6(p.fee), formatUnits6(p.net), p.payoutCurrency, p.payoutAmount ?? '', p.payTx ?? '', p.releaseTx ?? '', p.refundTx ?? '']
        .map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(','),
    )
    const sum = (f: (p: (typeof ps)[number]) => bigint) => ps.reduce((s, p) => s + f(p), 0n)
    const values = {
      day,
      corridor,
      payments: ps.length,
      gross: sum((p) => p.amount),
      fees: sum((p) => p.fee),
      net: sum((p) => p.net),
      refunded: sum((p) => (p.state === 'REFUNDED' ? (p.received ?? p.net) : 0n)),
      csv: [header, ...lines].join('\n') + '\n',
      matched: !ps.some((p) => bad.has(p.id)),
    }
    await ctx.db
      .insert(settlementReports)
      .values(values)
      .onConflictDoUpdate({ target: [settlementReports.day, settlementReports.corridor], set: values })
    out.push(values)
  }
  return out
}

export async function runReconciliation(ctx: Ctx, day = new Date().toISOString().slice(0, 10)) {
  const mismatches = await reconcile(ctx)
  const reports = await settlementReport(ctx, day, mismatches)
  ctx.log('reconciliation', { day, mismatches: mismatches.length, corridors: reports.length })
  return { mismatches, reports }
}
