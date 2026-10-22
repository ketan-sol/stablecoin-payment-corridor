import { eq, sql } from 'drizzle-orm'
import type { Db } from './db'
import { journalEntries, journalLines } from './db/schema'

/**
 * Double-entry accounts (the plan: sender, fees, in-transit, escrow, payout), per token:
 *   sender:<address>         what the business funded (credited when it pays, debited when refunded)
 *   fees                     signed fees collected in the FeeVault
 *   in_transit               burned on the source chain, not yet minted in escrow
 *   cctp_fees                anything CCTP kept between burn and mint
 *   escrow                   held by PaymentEscrow
 *   payout:<supplier>        released to the supplier or its off-ramp
 *   refunds:<address>        refunded on-chain, waiting for the refund address to pull it
 */
export type Account = string

export interface Line {
  account: Account
  amount: bigint // debit > 0, credit < 0
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export class UnbalancedEntry extends Error {}

/** Writes one balanced journal entry. Pass the surrounding transaction so it commits with the state change. */
export async function post(
  tx: Db | Tx,
  entry: { paymentId?: string; kind: string; token: string; memo?: string; lines: Line[] },
) {
  const lines = entry.lines.filter((l) => l.amount !== 0n)
  const sum = lines.reduce((s, l) => s + l.amount, 0n)
  if (sum !== 0n || lines.length < 2) throw new UnbalancedEntry(`${entry.kind}: lines sum to ${sum}`)
  const [row] = await tx
    .insert(journalEntries)
    .values({ paymentId: entry.paymentId, kind: entry.kind, token: entry.token, memo: entry.memo })
    .returning({ id: journalEntries.id })
  await tx.insert(journalLines).values(lines.map((l) => ({ entryId: row.id, account: l.account, amount: l.amount })))
  return row.id
}

export const debit = (account: Account, amount: bigint): Line => ({ account, amount })
export const credit = (account: Account, amount: bigint): Line => ({ account, amount: -amount })

/** Balance of every account (debits minus credits), optionally only those starting with `prefix`. */
export async function balances(db: Db, prefix = ''): Promise<Record<string, bigint>> {
  const rows = await db
    .select({ account: journalLines.account, total: sql<string>`sum(${journalLines.amount})` })
    .from(journalLines)
    .where(prefix ? sql`${journalLines.account} like ${prefix + '%'}` : undefined)
    .groupBy(journalLines.account)
  return Object.fromEntries(rows.map((r) => [r.account, BigInt(r.total)]))
}

export async function entriesFor(db: Db, paymentId: string) {
  const entries = await db.select().from(journalEntries).where(eq(journalEntries.paymentId, paymentId))
  const lines = entries.length
    ? await db
        .select()
        .from(journalLines)
        .where(sql`${journalLines.entryId} in ${entries.map((e) => e.id)}`)
    : []
  return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) }))
}
