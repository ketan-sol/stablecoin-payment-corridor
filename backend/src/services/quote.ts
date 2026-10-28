import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Address, Hex, TypedDataDefinition } from 'viem'
import { toJsonSafe, travelRuleHash, type QuoteView, type TravelRulePayload } from '@corridor/shared'
import type { Ctx } from '../ctx'
import { batches, counterparties, paymentEvents, payments, quotes } from '../db/schema'
import { encrypt, hmac, hmacEquals, randomBytes32, randomNonce } from '../crypto'
import { HttpError } from '../errors'
import { DEPEG_TOLERANCE, PAYOUT_CURRENCIES } from './fx'
import { batchIntentFor, batchTypedDataFor, typedDataFor } from './intents'
import { bps, convert, formatUnits6, parseUnits6 } from './money'
import { getCounterparty } from './counterparties'
import { transition, type Payment } from './transitions'

type Counterparty = typeof counterparties.$inferSelect

export interface CreatePaymentInput {
  businessId: string
  supplierId: string
  amountUsd: string // what the supplier is owed; the fee is added on top
  invoiceRef: string
  sourceChain: string
  payoutCurrency: string
  refundTo?: string // settlement-chain refund address; defaults to the business wallet
}

/** Signed after a payment's money first leaves the business, so daily limits count it. */
const COUNTS_TOWARD_LIMIT = ['SIGNED', 'FUNDED_SOURCE', 'IN_TRANSIT', 'ESCROWED', 'COMPLIANCE_CLEARED', 'PAYOUT_SENT', 'COMPLETED', 'FROZEN']

// ---------------------------------------------------------------- checks before any value moves

async function screenParties(ctx: Ctx, business: Counterparty, suppliers: Counterparty[]) {
  for (const c of [business, ...suppliers]) {
    if (c.kybStatus !== 'verified') throw new HttpError(403, `${c.name} has not passed KYB`, 'kyb')
    if (c.kybExpiresAt && c.kybExpiresAt < new Date()) throw new HttpError(403, `${c.name}'s KYB has expired`, 'kyb')
    const [onChainKyb, sanctioned, names] = await Promise.all([
      ctx.gw.isVerified(c.wallet as Address),
      ctx.gw.isSanctioned(c.wallet as Address),
      ctx.vendor.screenName(c.name),
    ])
    if (!onChainKyb) throw new HttpError(403, `${c.name} has no valid KYB attestation on-chain`, 'kyb')
    if (sanctioned) throw new HttpError(403, `${c.name}'s address is on the sanctions list`, 'sanctions')
    if (names.hit) throw new HttpError(403, `${c.name} matches ${names.list}`, 'sanctions')
  }
}

async function checkLimits(ctx: Ctx, business: Counterparty, amount: bigint) {
  const premium = business.tier === 'premium'
  const perPayment = parseUnits6(premium ? ctx.cfg.env.LIMIT_PER_PAYMENT_PREMIUM : ctx.cfg.env.LIMIT_PER_PAYMENT_STANDARD)
  const daily = parseUnits6(premium ? ctx.cfg.env.LIMIT_DAILY_PREMIUM : ctx.cfg.env.LIMIT_DAILY_STANDARD)
  if (amount > perPayment) throw new HttpError(422, `over the per-payment limit of ${formatUnits6(perPayment)} USD`, 'limit')
  const since = new Date(new Date().toISOString().slice(0, 10)) // UTC midnight
  const [{ total }] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${payments.net}), 0)` })
    .from(payments)
    .where(and(eq(payments.businessId, business.id), gte(payments.createdAt, since), inArray(payments.state, COUNTS_TOWARD_LIMIT)))
  if (BigInt(total) + amount > daily) throw new HttpError(422, `over the daily limit of ${formatUnits6(daily)} USD`, 'limit')
}

async function checkPeg(ctx: Ctx) {
  const px = await ctx.fx.usdcUsd()
  if (Math.abs(px - 1) > DEPEG_TOLERANCE) throw new HttpError(503, `USDC is at ${px}; quoting is paused`, 'depeg')
}

// ---------------------------------------------------------------- creating payments

function travelRule(business: Counterparty, supplier: Counterparty, invoiceRef: string, amountUsd: string): TravelRulePayload {
  return {
    originator: { name: business.name, accountNumber: business.wallet, country: business.country },
    beneficiary: { name: supplier.name, accountNumber: supplier.wallet, country: supplier.country },
    invoiceRef,
    amount: { value: amountUsd, currency: 'USD' },
  }
}

async function newPayment(
  ctx: Ctx,
  i: CreatePaymentInput,
  business: Counterparty,
  supplier: Counterparty,
  batch?: { id: string; index: number },
) {
  const net = parseUnits6(i.amountUsd)
  if (net <= 0n) throw new HttpError(400, 'amount must be positive')
  const tr = travelRule(business, supplier, i.invoiceRef, i.amountUsd)
  const [p] = await ctx.db
    .insert(payments)
    .values({
      paymentId: randomBytes32(),
      batchId: batch?.id,
      batchIndex: batch?.index,
      businessId: business.id,
      supplierId: supplier.id,
      state: 'CREATED',
      sourceChain: i.sourceChain,
      amountUsd: i.amountUsd,
      amount: net,
      fee: 0n,
      net,
      payoutCurrency: i.payoutCurrency,
      invoiceRef: i.invoiceRef,
      refundTo: i.refundTo ?? business.wallet,
      travelRuleHash: travelRuleHash(tr),
      travelRuleCiphertext: encrypt(ctx.cfg.travelRuleKey, JSON.stringify(tr)),
      payoutMethod: supplier.payoutMethod,
    })
    .returning()
  await ctx.db.insert(paymentEvents).values({
    paymentId: p.id,
    fromState: null,
    toState: 'CREATED',
    actor: `business:${business.id}`,
    reason: `invoice ${i.invoiceRef}`,
  })
  return p
}

function validate(ctx: Ctx, i: { sourceChain: string; payoutCurrency: string }) {
  if (!ctx.cfg.network.sources[i.sourceChain]) {
    throw new HttpError(400, `unknown source chain; use one of ${Object.keys(ctx.cfg.network.sources).join(', ')}`)
  }
  if (!PAYOUT_CURRENCIES.includes(i.payoutCurrency)) throw new HttpError(400, `unsupported payout currency ${i.payoutCurrency}`)
}

/** Step 1 of the flow: the business creates a payment. KYB, sanctions and limits are checked here already. */
export async function createPayment(ctx: Ctx, i: CreatePaymentInput): Promise<Payment> {
  validate(ctx, i)
  const business = await getCounterparty(ctx, i.businessId, 'business')
  const supplier = await getCounterparty(ctx, i.supplierId, 'supplier')
  await screenParties(ctx, business, [supplier])
  await checkLimits(ctx, business, parseUnits6(i.amountUsd))
  return newPayment(ctx, i, business, supplier)
}

// ---------------------------------------------------------------- quoting

function feeFor(ctx: Ctx, business: Counterparty, net: bigint) {
  const rate = business.tier === 'premium' ? ctx.cfg.env.FEE_BPS_PREMIUM : ctx.cfg.env.FEE_BPS_STANDARD
  const min = parseUnits6(ctx.cfg.env.MIN_FEE_USD)
  const fee = bps(net, rate)
  return fee > min ? fee : min
}

/**
 * Permit2 checks the deadline against the source chain's clock, not ours, so it is set from whichever is later:
 * a chain that runs ahead (or a local chain fast-forwarded in a demo) must not expire a fresh signature.
 */
async function permitDeadline(ctx: Ctx, source: string, quoteExpiresAt: Date) {
  const chainNow = await ctx.gw.now(source)
  const wallNow = Math.floor(Date.now() / 1000)
  return Math.max(chainNow, wallNow) + ctx.cfg.env.QUOTE_TTL_SEC + 600 // + time for the relayer to land it
}

const quoteMessage = (q: { id: string; paymentId: string; amount: bigint; fee: bigint; fxRate: string; expiresAt: Date }) =>
  `${q.id}|${q.paymentId}|${q.amount}|${q.fee}|${q.fxRate}|${q.expiresAt.toISOString()}`

/** Step 2: fee, FX rate, expiry. A new quote supersedes the previous one. */
export async function quotePayment(ctx: Ctx, id: string): Promise<QuoteView> {
  const [p] = await ctx.db.select().from(payments).where(eq(payments.id, id))
  if (!p) throw new HttpError(404, 'payment not found')
  if (p.batchId) throw new HttpError(409, 'quote the batch, not its legs')
  if (p.state !== 'CREATED' && p.state !== 'QUOTED') throw new HttpError(409, `payment is ${p.state}`)
  await checkPeg(ctx)
  const business = await getCounterparty(ctx, p.businessId)
  const supplier = await getCounterparty(ctx, p.supplierId)

  const fee = feeFor(ctx, business, p.net)
  const amount = p.net + fee
  const fxRate = await ctx.fx.rate(p.payoutCurrency)
  const payoutAmount = convert(p.net, fxRate)
  const expiresAt = new Date(Date.now() + ctx.cfg.env.QUOTE_TTL_SEC * 1000)
  const deadline = await permitDeadline(ctx, p.sourceChain, expiresAt)

  await ctx.db.update(quotes).set({ status: 'superseded' }).where(and(eq(quotes.paymentId, p.id), eq(quotes.status, 'active')))
  const [q] = await ctx.db
    .insert(quotes)
    .values({ paymentId: p.id, fee, fxRate, payoutCurrency: p.payoutCurrency, payoutAmount, expiresAt, token: 'pending' })
    .returning()
  const token = hmac(ctx.cfg.env.QUOTE_SECRET, quoteMessage({ id: q.id, paymentId: p.id, amount, fee, fxRate, expiresAt }))
  await ctx.db.update(quotes).set({ token }).where(eq(quotes.id, q.id))

  const updated = await transition(ctx, p, 'QUOTED', {
    actor: 'quote',
    reason: `fee ${formatUnits6(fee)} USD, ${p.payoutCurrency} at ${fxRate}`,
    patch: { fee, amount, fxRate, payoutAmount, permitNonce: randomNonce().toString(), deadline, quoteId: q.id, quoteExpiresAt: expiresAt },
  })
  if (!updated) throw new HttpError(409, 'payment changed while quoting; try again')
  return {
    quoteId: q.id,
    quoteToken: token,
    expiresAt: expiresAt.toISOString(),
    amount: amount.toString(),
    fee: fee.toString(),
    net: p.net.toString(),
    fxRate,
    payoutCurrency: p.payoutCurrency,
    payoutAmount,
    typedData: toJsonSafe(typedDataFor(ctx.cfg, updated, business.wallet as Address, supplier.wallet as Address)),
  }
}

async function useQuote(ctx: Ctx, quoteId: string, quoteToken: string, msg: Parameters<typeof quoteMessage>[0]) {
  const [q] = await ctx.db.select().from(quotes).where(eq(quotes.id, quoteId))
  if (!q || q.status !== 'active') throw new HttpError(409, 'quote is no longer valid; request a new one', 'quote')
  if (q.expiresAt < new Date()) throw new HttpError(410, 'quote expired; request a new one', 'quote_expired')
  if (!hmacEquals(ctx.cfg.env.QUOTE_SECRET, quoteMessage(msg), quoteToken)) throw new HttpError(400, 'quote token does not match')
  const used = await ctx.db
    .update(quotes)
    .set({ status: 'used' })
    .where(and(eq(quotes.id, q.id), eq(quotes.status, 'active')))
    .returning()
  if (!used.length) throw new HttpError(409, 'quote already used')
}

/** Step 3: the sender's one signature. Checked off-chain first so the relayer never spends gas on a bad one. */
export async function signPayment(ctx: Ctx, id: string, body: { quoteId: string; quoteToken: string; signature: Hex }) {
  const [p] = await ctx.db.select().from(payments).where(eq(payments.id, id))
  if (!p) throw new HttpError(404, 'payment not found')
  if (p.state !== 'QUOTED' || p.quoteId !== body.quoteId) throw new HttpError(409, `payment is ${p.state}`)
  const business = await getCounterparty(ctx, p.businessId)
  const supplier = await getCounterparty(ctx, p.supplierId)
  const typed = typedDataFor(ctx.cfg, p, business.wallet as Address, supplier.wallet as Address)
  const ok = await ctx.gw.verifyTypedData(p.sourceChain, business.wallet as Address, typed as unknown as TypedDataDefinition, body.signature)
  if (!ok) throw new HttpError(400, 'signature does not match the quote', 'signature')
  await useQuote(ctx, body.quoteId, body.quoteToken, {
    id: body.quoteId,
    paymentId: p.id,
    amount: p.amount,
    fee: p.fee,
    fxRate: p.fxRate!,
    expiresAt: p.quoteExpiresAt!,
  })
  const signed = await transition(ctx, p, 'SIGNED', { actor: `business:${business.id}`, patch: { signature: body.signature } })
  if (!signed) throw new HttpError(409, 'payment changed while signing')
  await ctx.queue.add('advance', { id: p.id }, { jobId: p.id })
  return signed
}

// ---------------------------------------------------------------- net settlement batches

export interface CreateBatchInput {
  businessId: string
  sourceChain: string
  payoutCurrency: string
  legs: { supplierId: string; amountUsd: string; invoiceRef: string }[]
}

/** Net settlement: many supplier payments, one quote, one signature, one CCTP transfer. */
export async function createBatch(ctx: Ctx, i: CreateBatchInput) {
  validate(ctx, i)
  const src = ctx.cfg.network.sources[i.sourceChain]
  if (src.kind !== 'evm') throw new HttpError(400, 'batches settle over CCTP (EVM sources only)')
  if (!i.legs.length || i.legs.length > 50) throw new HttpError(400, 'a batch has 1 to 50 payments')
  await checkPeg(ctx)
  const business = await getCounterparty(ctx, i.businessId, 'business')
  const suppliers = await Promise.all(i.legs.map((l) => getCounterparty(ctx, l.supplierId, 'supplier')))
  await screenParties(ctx, business, suppliers)
  const total = i.legs.reduce((s, l) => s + parseUnits6(l.amountUsd), 0n)
  await checkLimits(ctx, business, total)

  const fee = feeFor(ctx, business, total)
  const expiresAt = new Date(Date.now() + ctx.cfg.env.QUOTE_TTL_SEC * 1000)
  const deadline = await permitDeadline(ctx, i.sourceChain, expiresAt)
  const [batch] = await ctx.db
    .insert(batches)
    .values({ businessId: business.id, sourceChain: i.sourceChain, fee, net: total, permitNonce: randomNonce().toString(), deadline, quoteExpiresAt: expiresAt })
    .returning()

  const fxRate = await ctx.fx.rate(i.payoutCurrency)
  const legs: { p: Payment; receiver: Address }[] = []
  for (const [index, l] of i.legs.entries()) {
    const created = await newPayment(ctx, { ...l, businessId: business.id, sourceChain: i.sourceChain, payoutCurrency: i.payoutCurrency }, business, suppliers[index], { id: batch.id, index })
    // The whole fee rides on the first leg, so each leg's amount + fee adds up to the permitted total.
    const legFee = index === 0 ? fee : 0n
    const quoted = await transition(ctx, created, 'QUOTED', {
      actor: 'quote',
      reason: `batch ${batch.id} leg ${index + 1}/${i.legs.length}`,
      patch: { fee: legFee, amount: created.net + legFee, fxRate, payoutAmount: convert(created.net, fxRate), permitNonce: batch.permitNonce, deadline, quoteExpiresAt: expiresAt },
    })
    legs.push({ p: quoted!, receiver: suppliers[index].wallet as Address })
  }
  const intent = batchIntentFor(ctx.cfg, legs, fee, business.wallet as Address)
  const token = hmac(ctx.cfg.env.QUOTE_SECRET, `batch|${batch.id}|${total}|${fee}|${expiresAt.toISOString()}`)
  return {
    batchId: batch.id,
    quoteToken: token,
    expiresAt: expiresAt.toISOString(),
    amount: (total + fee).toString(),
    fee: fee.toString(),
    net: total.toString(),
    fxRate,
    payments: legs.map(({ p }) => p.id),
    typedData: toJsonSafe(batchTypedDataFor(ctx.cfg, i.sourceChain, intent, batch.permitNonce, deadline)),
  }
}

export async function signBatch(ctx: Ctx, batchId: string, body: { quoteToken: string; signature: Hex }) {
  const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, batchId))
  if (!batch) throw new HttpError(404, 'batch not found')
  if (batch.signature) throw new HttpError(409, 'batch already signed')
  if (batch.quoteExpiresAt < new Date()) throw new HttpError(410, 'quote expired; create the batch again', 'quote_expired')
  if (!hmacEquals(ctx.cfg.env.QUOTE_SECRET, `batch|${batch.id}|${batch.net}|${batch.fee}|${batch.quoteExpiresAt.toISOString()}`, body.quoteToken)) {
    throw new HttpError(400, 'quote token does not match')
  }
  const legs = await ctx.db.select().from(payments).where(eq(payments.batchId, batchId)).orderBy(asc(payments.batchIndex))
  const business = await getCounterparty(ctx, batch.businessId)
  const receivers = await Promise.all(legs.map(async (p) => ((await getCounterparty(ctx, p.supplierId)).wallet) as Address))
  const intent = batchIntentFor(ctx.cfg, legs.map((p, k) => ({ p, receiver: receivers[k] })), batch.fee, business.wallet as Address)
  const typed = batchTypedDataFor(ctx.cfg, batch.sourceChain, intent, batch.permitNonce, batch.deadline)
  const ok = await ctx.gw.verifyTypedData(batch.sourceChain, business.wallet as Address, typed as unknown as TypedDataDefinition, body.signature)
  if (!ok) throw new HttpError(400, 'signature does not match the batch', 'signature')

  const claimed = await ctx.db
    .update(batches)
    .set({ signature: body.signature })
    .where(and(eq(batches.id, batchId), sql`${batches.signature} is null`))
    .returning()
  if (!claimed.length) throw new HttpError(409, 'batch already signed')
  for (const p of legs) {
    await transition(ctx, p, 'SIGNED', { actor: `business:${business.id}`, patch: { signature: body.signature } })
    await ctx.queue.add('advance', { id: p.id }, { jobId: p.id })
  }
  return { batchId, payments: legs.map((p) => p.id) }
}
