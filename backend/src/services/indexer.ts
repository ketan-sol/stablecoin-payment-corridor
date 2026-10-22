import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { decodeEventLog, type Abi, type Address } from 'viem'
import { paymentEscrowAbi, paymentRouterAbi } from '@corridor/shared'
import type { Ctx } from '../ctx'
import { chainEvents, indexerCursors, opsCases, payments } from '../db/schema'
import { postings } from './accounting'
import { wake } from './orchestrator'

interface Watched {
  chain: string
  contract: string
  address: Address
  abi: Abi
}

const MAX_RANGE = 2_000
const INITIAL_LOOKBACK = 5_000

function watched(ctx: Ctx): Watched[] {
  const { network } = ctx.cfg
  const w: Watched[] = [{ chain: 'settlement', contract: 'escrow', address: network.settlement.escrow, abi: paymentEscrowAbi as Abi }]
  for (const s of Object.values(network.sources)) {
    w.push({ chain: s.key, contract: 'router', address: s.router, abi: paymentRouterAbi as Abi })
  }
  return w
}

const jsonArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))

/**
 * One pass: read each watched contract up to `head - confirmations` (reorg-safe), store events once, react.
 * Steps never depend on the indexer (they read chain state themselves); it records events for reconciliation
 * and wakes payments early when officers act.
 */
export async function indexOnce(ctx: Ctx) {
  for (const w of watched(ctx)) {
    const cursorKey = `${w.chain}:${w.address.toLowerCase()}`
    const head = (await ctx.gw.blockNumber(w.chain)) - ctx.cfg.confirmations
    const [cursor] = await ctx.db.select().from(indexerCursors).where(eq(indexerCursors.key, cursorKey))
    let from = cursor ? cursor.block + 1 : Math.max(0, head - INITIAL_LOOKBACK)
    while (from <= head) {
      const to = Math.min(head, from + MAX_RANGE - 1)
      const logs = await ctx.gw.logs(w.chain, w.address, from, to)
      const keys: string[] = []
      for (const log of logs) {
        let decoded: { eventName: string; args: Record<string, unknown> }
        try {
          decoded = decodeEventLog({ abi: w.abi, data: log.data, topics: log.topics }) as unknown as typeof decoded
        } catch {
          continue // events from parent contracts we don't track (RoleGranted, Initialized...)
        }
        const args = jsonArgs(decoded.args ?? {})
        const key = (args.key ?? args.paymentId ?? null) as string | null
        const inserted = await ctx.db
          .insert(chainEvents)
          .values({
            chain: w.chain,
            contract: w.contract,
            name: decoded.eventName,
            blockNumber: Number(log.blockNumber),
            blockHash: log.blockHash!,
            txHash: log.transactionHash!,
            logIndex: log.logIndex!,
            args,
            key,
          })
          .onConflictDoNothing()
          .returning({ id: chainEvents.id })
        if (!inserted.length) continue // seen before
        await react(ctx, w, decoded.eventName, args)
        if (key) keys.push(key)
      }
      await wake(ctx, keys)
      await ctx.db
        .insert(indexerCursors)
        .values({ key: cursorKey, block: to })
        .onConflictDoUpdate({ target: indexerCursors.key, set: { block: to } })
      from = to + 1
    }
  }
}

async function react(ctx: Ctx, w: Watched, name: string, args: Record<string, unknown>) {
  if (w.contract === 'escrow' && name === 'Unattributed') {
    await ctx.db.insert(opsCases).values({
      kind: 'unattributed',
      title: `Unattributed funds from domain ${args.sourceDomain} (nonce ${String(args.cctpNonce).slice(0, 18)}…)`,
      detail: args,
    })
  }
  if (w.contract === 'escrow' && name === 'RefundWithdrawn') {
    await refundWithdrawn(ctx, String(args.account), BigInt(String(args.amount)))
  }
}

/** A pull withdraws everything owed to the account: book it, and mark that account's refunded payments, oldest first. */
async function refundWithdrawn(ctx: Ctx, account: string, amount: bigint) {
  await ctx.db.transaction(async (tx) => {
    await postings.refundWithdrawn(tx, account, amount)
    const open = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.state, 'REFUNDED'), isNull(payments.refundWithdrawTx), sql`lower(${payments.refundTo}) = ${account.toLowerCase()}`))
      .orderBy(asc(payments.updatedAt))
    let left = amount
    for (const p of open) {
      const owed = p.received ?? p.net
      if (owed > left) break
      left -= owed
      await tx.update(payments).set({ refundWithdrawTx: 'withdrawn' }).where(eq(payments.id, p.id))
    }
  })
}
