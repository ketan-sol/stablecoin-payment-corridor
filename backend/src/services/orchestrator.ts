import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import type { Address, Hash, Hex } from 'viem'
import { escrowKey, TERMINAL_STATES, travelRuleHash, type PaymentState } from '@corridor/shared'
import type { EscrowRecord } from '../chain/gateway'
import type { Ctx } from '../ctx'
import { batches, opsCases, paymentEvents, payments } from '../db/schema'
import { decrypt } from '../crypto'
import { errorMessage, isRevert } from '../errors'
import { postings } from './accounting'
import { getCounterparty } from './counterparties'
import { batchIntentFor, intentFor, permitFor } from './intents'
import { pacs008 } from './iso20022'
import { adapterFor } from './payout'
import { savePatch, transition, type Payment } from './transitions'

/** What a step did: moved to a new state (run again now), is waiting on something (poll), or is idle (a human acts). */
type Step = 'moved' | 'wait' | 'idle'

const ATTESTATION_ALERT_MS = 30 * 60_000

/** The `advance` job: run steps until the payment waits, then reschedule. Idempotency key = payment ID. */
export async function advance(ctx: Ctx, id: string): Promise<PaymentState | null> {
  for (let i = 0; i < 20; i++) {
    const [p] = await ctx.db.select().from(payments).where(eq(payments.id, id))
    if (!p || TERMINAL_STATES.includes(p.state as PaymentState)) return (p?.state as PaymentState) ?? null
    let result: Step
    try {
      result = await step(ctx, p)
    } catch (e) {
      // Transient (RPC down, nonce race): record it and retry with backoff. Nothing is lost; every step re-reads chain state.
      await savePatch(ctx, p, { lastError: errorMessage(e), attempts: p.attempts + 1 })
      ctx.log('step failed', { id, state: p.state, error: errorMessage(e) })
      await ctx.queue.add('advance', { id }, { delayMs: Math.min(60_000, 1000 * 2 ** Math.min(p.attempts, 6)), jobId: id })
      return p.state as PaymentState
    }
    if (result === 'moved') continue
    if (result === 'wait') await ctx.queue.add('advance', { id }, { delayMs: pollDelay(ctx, p.state as PaymentState), jobId: id })
    return p.state as PaymentState
  }
  await ctx.queue.add('advance', { id }, { jobId: id })
  return null
}

const pollDelay = (ctx: Ctx, s: PaymentState) => (s === 'FROZEN' ? ctx.cfg.env.POLL_MS * 5 : ctx.cfg.env.POLL_MS)

async function step(ctx: Ctx, p: Payment): Promise<Step> {
  switch (p.state as PaymentState) {
    case 'CREATED':
    case 'QUOTED':
      return 'idle' // waiting for the sender
    case 'SIGNED':
      return p.batchId ? submitBatch(ctx, p) : submit(ctx, p)
    case 'FUNDED_SOURCE':
      return fundedSource(ctx, p)
    case 'IN_TRANSIT':
      return inTransit(ctx, p)
    case 'ESCROWED':
      return escrowed(ctx, p)
    case 'COMPLIANCE_CLEARED':
      return cleared(ctx, p)
    case 'PAYOUT_SENT':
      return payoutSent(ctx, p)
    case 'FROZEN':
      return frozen(ctx, p)
    case 'REFUNDING':
      return refunding(ctx, p)
    default:
      return 'idle'
  }
}

// ---------------------------------------------------------------- helpers

const source = (ctx: Ctx, p: Payment) => ctx.cfg.network.sources[p.sourceChain]

async function confirmed(ctx: Ctx, chain: string, hash: Hash) {
  const r = await ctx.gw.receipt(chain, hash)
  if (r.status === 'pending') return r
  if (ctx.cfg.confirmations > 0) {
    const head = await ctx.gw.blockNumber(chain)
    if (head - r.blockNumber < ctx.cfg.confirmations) return { status: 'pending' as const }
  }
  return r
}

async function openCase(ctx: Ctx, p: Payment | null, kind: (typeof opsCases.$inferInsert)['kind'], title: string, detail?: object) {
  // One open case per payment and kind.
  if (p) {
    const open = await ctx.db
      .select({ id: opsCases.id })
      .from(opsCases)
      .where(and(eq(opsCases.paymentId, p.id), eq(opsCases.kind, kind), eq(opsCases.status, 'open')))
    if (open.length) return
  }
  await ctx.db.insert(opsCases).values({ paymentId: p?.id, kind, title, detail: detail ?? null })
  ctx.log('ops case', { kind, title, payment: p?.id })
}

/** Sending failed. A revert means nothing moved (back to the quote); anything else is retried. */
async function relayFailed(ctx: Ctx, p: Payment, e: unknown): Promise<Step> {
  if (!isRevert(e)) throw e
  await transition(ctx, p, 'QUOTED', { actor: 'relayer', reason: `relay reverted: ${errorMessage(e)}`, patch: { payTx: null, signature: null } })
  await ctx.db.update(payments).set({ lastError: errorMessage(e) }).where(eq(payments.id, p.id))
  return 'idle'
}

// ---------------------------------------------------------------- SIGNED: relay the intent

async function submit(ctx: Ctx, p: Payment): Promise<Step> {
  if (!p.payTx) {
    const business = await getCounterparty(ctx, p.businessId)
    const supplier = await getCounterparty(ctx, p.supplierId)
    try {
      const payTx = await ctx.gw.pay(
        p.sourceChain,
        intentFor(ctx.cfg, p, supplier.wallet as Address),
        permitFor(ctx.cfg, p.sourceChain, p.amount, p.permitNonce!, p.deadline!),
        business.wallet as Address,
        p.signature as Hex,
      )
      await savePatch(ctx, p, { payTx })
    } catch (e) {
      return relayFailed(ctx, p, e)
    }
    return 'wait'
  }
  return afterPay(ctx, p, p.payTx as Hash)
}

/** Net settlement: the first leg relays the batch; every leg then follows the shared transaction. */
async function submitBatch(ctx: Ctx, p: Payment): Promise<Step> {
  const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, p.batchId!))
  if (!batch.payTx) {
    if (p.batchIndex !== 0) return 'wait'
    const legs = await ctx.db.select().from(payments).where(eq(payments.batchId, batch.id)).orderBy(asc(payments.batchIndex))
    const business = await getCounterparty(ctx, batch.businessId)
    const receivers = await Promise.all(legs.map(async (l) => (await getCounterparty(ctx, l.supplierId)).wallet as Address))
    const intent = batchIntentFor(ctx.cfg, legs.map((l, k) => ({ p: l, receiver: receivers[k] })), batch.fee, business.wallet as Address)
    try {
      const payTx = await ctx.gw.payBatch(
        batch.sourceChain,
        intent,
        permitFor(ctx.cfg, batch.sourceChain, batch.net + batch.fee, batch.permitNonce, batch.deadline),
        business.wallet as Address,
        batch.signature as Hex,
      )
      await ctx.db.update(batches).set({ payTx }).where(eq(batches.id, batch.id))
      for (const l of legs) await savePatch(ctx, l, { payTx })
    } catch (e) {
      if (!isRevert(e)) throw e
      // The whole batch failed on-chain and nothing moved; each leg goes back to QUOTED with the reason.
      for (const l of legs) await relayFailed(ctx, l, e)
      return 'idle'
    }
    return 'wait'
  }
  if (!p.payTx) await savePatch(ctx, p, { payTx: batch.payTx })
  return afterPay(ctx, { ...p, payTx: batch.payTx }, batch.payTx as Hash)
}

async function afterPay(ctx: Ctx, p: Payment, payTx: Hash): Promise<Step> {
  const r = await confirmed(ctx, p.sourceChain, payTx)
  if (r.status === 'pending') return 'wait'
  if (r.status === 'reverted') {
    await transition(ctx, p, 'QUOTED', { actor: 'relayer', reason: 'pay transaction reverted; nothing moved', patch: { payTx: null, signature: null } })
    return 'idle'
  }
  const src = source(ctx, p)
  const business = await getCounterparty(ctx, p.businessId)
  await transition(ctx, p, 'FUNDED_SOURCE', {
    actor: 'relayer',
    reason: `${src.tokenSymbol} pulled on ${src.name}`,
    patch: { payTx, payBlock: r.blockNumber, payBlockHash: r.blockHash, escrowKey: escrowKey(src.domain, p.paymentId as Hex) },
    ledger: (tx, row) => postings.fundedSource(tx, row, business.wallet),
  })
  return 'moved'
}

// ---------------------------------------------------------------- FUNDED_SOURCE → IN_TRANSIT

async function fundedSource(ctx: Ctx, p: Payment): Promise<Step> {
  const message = await ctx.gw.cctpMessage(p.sourceChain, p.payTx as Hash)
  if (!message) throw new Error('pay transaction has no CCTP MessageSent log')
  await transition(ctx, p, 'IN_TRANSIT', { actor: 'orchestrator', reason: 'CCTP burn final; waiting for attestation', patch: { cctpMessage: message } })
  return 'moved'
}

// ---------------------------------------------------------------- IN_TRANSIT: attestation → receivePayment

async function inTransit(ctx: Ctx, p: Payment): Promise<Step> {
  const key = p.escrowKey as Hex
  const rec = await ctx.gw.escrowPayment(key)
  if (rec.status !== 'None') return escrowedNow(ctx, p, rec.amount)

  // A batch delivers once: only the first leg sends receivePayment; the others watch for their key.
  if (p.batchId && p.batchIndex !== 0) return 'wait'

  if (p.receiveTx) {
    const r = await confirmed(ctx, 'settlement', p.receiveTx as Hash)
    if (r.status === 'pending') return 'wait'
    if (r.status === 'success') {
      // Delivered, but no payment for this key: the escrow kept it as unattributed. Never auto-resolved.
      await openCase(ctx, p, 'unattributed', 'CCTP message landed but the escrow did not record the payment', { receiveTx: p.receiveTx })
      await savePatch(ctx, p, { lastError: 'escrow kept the funds as unattributed; see ops case' })
      return 'idle'
    }
    await savePatch(ctx, p, { receiveTx: null }) // reverted (e.g. someone delivered first): re-check and retry
    return 'wait'
  }

  const att = await ctx.gw.attestation(p.sourceChain, p.payTx as Hash, p.cctpMessage as Hex)
  if (!att) {
    if (Date.now() - p.updatedAt.getTime() > ATTESTATION_ALERT_MS) {
      await openCase(ctx, p, 'stuck', 'CCTP attestation delayed over 30 minutes', { payTx: p.payTx })
    }
    return 'wait' // payment shows "In transit"; nothing is double-minted because only one delivery can succeed
  }
  try {
    const receiveTx = await ctx.gw.receivePayment(att.message, att.attestation)
    await savePatch(ctx, p, { receiveTx, attestation: att.attestation, cctpMessage: att.message })
  } catch (e) {
    if (!isRevert(e)) throw e
    await savePatch(ctx, p, { lastError: errorMessage(e) }) // e.g. already delivered: the next pass sees the key
  }
  return 'wait'
}

async function escrowedNow(ctx: Ctx, p: Payment, received: bigint): Promise<Step> {
  await transition(ctx, p, 'ESCROWED', {
    actor: 'relayer',
    reason: 'minted into escrow',
    patch: { received },
    ledger: (tx, row) => postings.escrowed(tx, row, received),
  })
  return 'moved'
}

// ---------------------------------------------------------------- ESCROWED: compliance gate

const RECORD_MISMATCH = 'escrow record does not match the signed payment'

/** The escrow record matches what the business signed and the router burned, sanctions (oracle + vendor), KYB
 * attestations, and the Travel Rule payload present and matching its signed hash. */
export async function complianceCheck(ctx: Ctx, p: Payment, rec: EscrowRecord): Promise<{ ok: boolean; reasons: string[] }> {
  const business = await getCounterparty(ctx, p.businessId)
  const supplier = await getCounterparty(ctx, p.supplierId)
  const reasons: string[] = []
  // The escrow trusts Circle's attestation (ECDSA). A forged one (e.g. an attester key broken by a quantum computer)
  // could land another receiver or refund address under this payment's key; never pay that out. No override.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const wrong = [
    !same(rec.sender, business.wallet) && 'sender',
    !same(rec.receiver, supplier.wallet) && 'receiver',
    !same(rec.refundTo, p.refundTo) && 'refund address',
    !same(rec.token, ctx.cfg.network.settlement.usdc) && 'token',
    rec.amount > p.net && 'amount above the burn',
  ].filter(Boolean)
  if (wrong.length) reasons.push(`${RECORD_MISMATCH} (${wrong.join(', ')})`)
  if (!(await ctx.gw.isAllowed(business.wallet as Address, supplier.wallet as Address))) {
    reasons.push('registry: KYB missing/expired or address sanctioned')
  }
  // A false positive cleared by two officers (FROZEN → ESCROWED) is not re-flagged on the name check.
  const overridden = (
    await ctx.db
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.paymentId, p.id), eq(paymentEvents.fromState, 'FROZEN'), eq(paymentEvents.toState, 'ESCROWED')))
  ).length
  if (!overridden) {
    for (const c of [business, supplier]) {
      const s = await ctx.vendor.screenName(c.name)
      if (s.hit) reasons.push(`${c.name} matches ${s.list}`)
    }
  }
  try {
    const payload = JSON.parse(decrypt(ctx.cfg.travelRuleKey, p.travelRuleCiphertext))
    if (travelRuleHash(payload) !== p.travelRuleHash) reasons.push('travel rule payload does not match its signed hash')
    else if (!payload.originator?.name || !payload.beneficiary?.name) reasons.push('travel rule payload incomplete')
  } catch {
    reasons.push('travel rule payload missing or unreadable')
  }
  return { ok: reasons.length === 0, reasons }
}

async function escrowed(ctx: Ctx, p: Payment): Promise<Step> {
  const rec = await ctx.gw.escrowPayment(p.escrowKey as Hex)
  if (rec.status === 'Frozen') return frozenNow(ctx, p, 'frozen on-chain by compliance')
  if (rec.status === 'Refunded') return refundedNow(ctx, p)

  const check = await complianceCheck(ctx, p, rec)
  if (check.ok) {
    await transition(ctx, p, 'COMPLIANCE_CLEARED', { actor: 'compliance', reason: 'sanctions, KYB and Travel Rule clear' })
    return 'moved'
  }
  // Hold it on-chain before anyone (including the timeout refund) can move it, and open an ops case.
  if (!p.freezeTx) {
    const forged = check.reasons.some((r) => r.startsWith(RECORD_MISMATCH))
    const title = forged
      ? 'Escrow record does not match the source-chain burn (possible forged attestation); frozen. Do not unfreeze or refund'
      : 'Compliance hit; payment frozen in escrow'
    await openCase(ctx, p, 'compliance', title, { reasons: check.reasons })
    const freezeTx = await ctx.gw.freeze(p.escrowKey as Hex)
    await savePatch(ctx, p, { freezeTx, lastError: check.reasons.join('; ') })
    return 'wait'
  }
  const r = await confirmed(ctx, 'settlement', p.freezeTx as Hash)
  if (r.status === 'pending') return 'wait'
  if (r.status === 'reverted') await savePatch(ctx, p, { freezeTx: null })
  return 'wait' // the next pass sees Frozen on-chain
}

async function frozenNow(ctx: Ctx, p: Payment, reason: string): Promise<Step> {
  await transition(ctx, p, 'FROZEN', { actor: 'compliance', reason })
  return 'moved'
}

async function refundedNow(ctx: Ctx, p: Payment, refundTx?: Hash): Promise<Step> {
  await transition(ctx, p, 'REFUNDED', {
    actor: 'escrow',
    reason: 'refund credited; the refund address can withdraw it',
    patch: refundTx ? { refundTx } : undefined,
    ledger: (tx, row) => postings.refunded(tx, row),
  })
  return 'moved'
}

// ---------------------------------------------------------------- COMPLIANCE_CLEARED → PAYOUT_SENT

async function cleared(ctx: Ctx, p: Payment): Promise<Step> {
  const supplier = await getCounterparty(ctx, p.supplierId)
  const business = await getCounterparty(ctx, p.businessId)
  const adapter = adapterFor(supplier.payoutMethod)
  try {
    const { ref, releaseTx } = await adapter.send(ctx, p, supplier)
    await transition(ctx, p, 'PAYOUT_SENT', {
      actor: `payout:${adapter.method}`,
      reason: adapter.method === 'bank' ? 'bank transfer sent by the off-ramp' : 'USDC released to the supplier wallet',
      patch: { payoutMethod: adapter.method, payoutRef: ref, payoutStatus: 'pending', releaseTx: releaseTx ?? null, pacs008: pacs008(p, business, supplier) },
    })
  } catch (e) {
    if (!isRevert(e)) throw e
    // Release refused on-chain (compliance changed since the check): back through the gate.
    await transition(ctx, p, 'ESCROWED', { actor: 'payout', reason: `release refused: ${errorMessage(e)}` })
  }
  return 'moved'
}

// ---------------------------------------------------------------- PAYOUT_SENT → COMPLETED | REFUNDING

async function payoutSent(ctx: Ctx, p: Payment): Promise<Step> {
  const key = p.escrowKey as Hex
  const rec = await ctx.gw.escrowPayment(key)
  if (rec.status === 'Released') {
    const business = await getCounterparty(ctx, p.businessId)
    const supplier = await getCounterparty(ctx, p.supplierId)
    await transition(ctx, p, 'COMPLETED', {
      actor: `payout:${p.payoutMethod}`,
      reason: 'supplier paid',
      patch: { payoutStatus: 'settled', pacs008: pacs008({ ...p, payoutStatus: 'settled' }, business, supplier) },
      ledger: (tx, row) => postings.released(tx, row),
    })
    return 'moved'
  }
  if (rec.status === 'Refunded') return refunding(ctx, { ...p }, true)
  if (rec.status === 'Frozen') return frozenNow(ctx, p, 'frozen by compliance during payout')

  const supplier = await getCounterparty(ctx, p.supplierId)
  const adapter = adapterFor(p.payoutMethod ?? supplier.payoutMethod)
  const status = await adapter.status(ctx, p, supplier)

  if (adapter.method === 'wallet') {
    if (status === 'failed') {
      await transition(ctx, p, 'ESCROWED', { actor: 'payout:wallet', reason: 'release reverted; re-checking compliance', patch: { releaseTx: null } })
      return 'moved'
    }
    return 'wait' // pending; the next pass sees Released
  }

  // Bank: the off-ramp paid in fiat; reimburse it with the escrow release.
  if (status === 'settled') {
    if (!p.releaseTx) {
      try {
        const releaseTx = await ctx.gw.release(key, ctx.cfg.network.offRamp)
        await savePatch(ctx, p, { releaseTx, payoutStatus: 'settled' })
      } catch (e) {
        if (!isRevert(e)) throw e
        await savePatch(ctx, p, { lastError: `release to off-ramp refused: ${errorMessage(e)}` })
      }
    }
    return 'wait'
  }
  if (status === 'failed') {
    if (p.payoutStatus !== 'failed') {
      await savePatch(ctx, p, { payoutStatus: 'failed', lastError: 'off-ramp transfer failed' })
      await openCase(ctx, p, 'payout', 'Off-ramp transfer failed; refund after the escrow window', { ref: p.payoutRef })
    }
    // The plan: off-ramp fails → escrow refunds the sender after the window. Funds never left escrow.
    const [now, window] = await Promise.all([ctx.gw.now(), ctx.gw.refundWindow()])
    if (now < rec.escrowedAt + window) return 'wait'
    const refundTx = await ctx.gw.claimRefund(key)
    await transition(ctx, p, 'REFUNDING', { actor: 'keeper', reason: 'refund window passed after off-ramp failure', patch: { refundTx } })
    return 'moved'
  }
  return 'wait'
}

// ---------------------------------------------------------------- FROZEN, REFUNDING

async function frozen(ctx: Ctx, p: Payment): Promise<Step> {
  const rec = await ctx.gw.escrowPayment(p.escrowKey as Hex)
  if (rec.status === 'Escrowed') {
    // Clear the old freeze so the gate can freeze again if the re-check still fails.
    await transition(ctx, p, 'ESCROWED', { actor: 'compliance', reason: 'unfrozen by two compliance officers', patch: { freezeTx: null } })
    return 'moved'
  }
  if (rec.status === 'Refunded') return refundedNow(ctx, p)
  return 'wait' // officers decide in the ops console
}

async function refunding(ctx: Ctx, p: Payment, alreadyRefunded = false): Promise<Step> {
  if (!alreadyRefunded) {
    const rec = await ctx.gw.escrowPayment(p.escrowKey as Hex)
    if (rec.status !== 'Refunded') {
      const r = p.refundTx ? await confirmed(ctx, 'settlement', p.refundTx as Hash) : null
      if (r?.status === 'reverted') await savePatch(ctx, p, { refundTx: await ctx.gw.claimRefund(p.escrowKey as Hex) })
      return 'wait'
    }
  }
  if (p.state === 'PAYOUT_SENT') {
    const moved = await transition(ctx, p, 'REFUNDING', { actor: 'escrow', reason: 'refunded on-chain' })
    if (!moved) return 'moved'
    return refundedNow(ctx, moved)
  }
  return refundedNow(ctx, p)
}

// ---------------------------------------------------------------- recovery

/** On startup: re-enqueue every payment that is mid-flight (the queue may have been lost with the process). */
export async function resumeAll(ctx: Ctx) {
  const open = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(notInArray(payments.state, [...TERMINAL_STATES, 'CREATED', 'QUOTED']))
  for (const { id } of open) await ctx.queue.add('advance', { id }, { jobId: id })
  return open.length
}

/** Wake the payments whose escrow keys just showed up in chain events (officer actions, deliveries). */
export async function wake(ctx: Ctx, keys: string[]) {
  if (!keys.length) return
  const rows = await ctx.db.select({ id: payments.id }).from(payments).where(inArray(payments.escrowKey, keys))
  for (const { id } of rows) await ctx.queue.add('advance', { id }, { jobId: id })
}
