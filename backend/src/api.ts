import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z, ZodError } from 'zod'
import { getAddress, isAddress, type Hex } from 'viem'
import { STATE_LABELS, type PaymentState } from '@corridor/shared'
import type { Ctx } from './ctx'
import { counterparties, opsCases, payments, settlementReports, webhookDeliveries } from './db/schema'
import { HttpError } from './errors'
import { balances, entriesFor } from './ledger'
import { counterpartyView, getCounterparty, onboard } from './services/counterparties'
import { createBatch, createPayment, quotePayment, signBatch, signPayment } from './services/quote'
import { runReconciliation } from './services/reconciliation'
import { paymentView, paymentViews, publicConfig } from './services/views'

const address = z.string().refine((a) => isAddress(a), 'invalid address').transform((a) => getAddress(a))
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((v) => v as Hex)
const usd = z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount in USD, e.g. 1000.00')

const Onboard = z.object({
  name: z.string().min(2).max(140),
  country: z.string().length(2),
  wallet: address,
  tier: z.enum(['standard', 'premium']).optional(),
  payoutMethod: z.enum(['wallet', 'bank']).optional(),
  bankAccount: z.object({ bankName: z.string().min(2), accountNumber: z.string().min(4), currency: z.string().length(3) }).nullish(),
  webhookUrl: z.url().nullish(),
})
const CreatePayment = z.object({
  businessId: z.uuid(),
  supplierId: z.uuid(),
  amountUsd: usd,
  invoiceRef: z.string().min(1).max(64),
  sourceChain: z.string(),
  payoutCurrency: z.string().length(3),
  refundTo: address.optional(),
})
const Sign = z.object({ quoteId: z.uuid(), quoteToken: z.string(), signature: hex })
const CreateBatch = z.object({
  businessId: z.uuid(),
  sourceChain: z.string(),
  payoutCurrency: z.string().length(3),
  legs: z.array(z.object({ supplierId: z.uuid(), amountUsd: usd, invoiceRef: z.string().min(1).max(64) })).min(1).max(50),
})
const SignBatch = z.object({ quoteToken: z.string(), signature: hex })

export function buildApi(ctx: Ctx): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(cors, { origin: true })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code })
    if (err instanceof ZodError) return reply.status(400).send({ error: z.prettifyError(err), code: 'invalid' })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: (err as Error).message, code: 'invalid' })
    ctx.log('api error', { error: (err as Error).message })
    return reply.status(500).send({ error: 'internal error', code: 'internal' })
  })

  const ops = (req: FastifyRequest) => {
    if (req.headers['x-ops-token'] !== ctx.cfg.env.OPS_TOKEN) throw new HttpError(401, 'ops token required')
  }
  const loadPayment = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'payment not found')
    const [p] = await ctx.db.select().from(payments).where(eq(payments.id, id))
    if (!p) throw new HttpError(404, 'payment not found')
    return p
  }

  app.get('/health', async () => ({ ok: true }))
  app.get('/config', async () => publicConfig(ctx))

  // ------------------------------------------------------------ onboarding (KYB once, attestation on-chain)
  for (const kind of ['business', 'supplier'] as const) {
    const path = kind === 'business' ? '/businesses' : '/suppliers'
    app.post(path, async (req, reply) => {
      const c = await onboard(ctx, { kind, ...Onboard.parse(req.body) })
      return reply.status(201).send({ ...counterpartyView(c), kybReason: c.kybReason })
    })
    app.get(path, async (req) => {
      const q = z.object({ wallet: address.optional() }).parse(req.query)
      const rows = await ctx.db
        .select()
        .from(counterparties)
        .where(and(eq(counterparties.kind, kind), q.wallet ? eq(counterparties.wallet, q.wallet) : undefined))
        .orderBy(counterparties.name)
      return rows.map(counterpartyView)
    })
    app.get(`${path}/:id`, async (req) => counterpartyView(await getCounterparty(ctx, (req.params as { id: string }).id, kind)))
  }
  app.patch('/suppliers/:id/payout-method', async (req) => {
    const s = await getCounterparty(ctx, (req.params as { id: string }).id, 'supplier')
    const b = z.object({ payoutMethod: z.enum(['wallet', 'bank']), bankAccount: Onboard.shape.bankAccount }).parse(req.body)
    if (b.payoutMethod === 'bank' && !b.bankAccount && !s.bankAccount) throw new HttpError(400, 'bank payouts need bank account details')
    const [row] = await ctx.db
      .update(counterparties)
      .set({ payoutMethod: b.payoutMethod, bankAccount: b.bankAccount ?? s.bankAccount })
      .where(eq(counterparties.id, s.id))
      .returning()
    return counterpartyView(row)
  })

  // ------------------------------------------------------------ payments
  app.post('/payments', async (req, reply) => {
    const p = await createPayment(ctx, CreatePayment.parse(req.body))
    return reply.status(201).send(await paymentView(ctx, p))
  })
  app.post('/payments/:id/quote', async (req) => quotePayment(ctx, (req.params as { id: string }).id))
  app.post('/payments/:id/sign', async (req, reply) => {
    const p = await signPayment(ctx, (req.params as { id: string }).id, Sign.parse(req.body))
    return reply.status(202).send(await paymentView(ctx, p))
  })
  app.get('/payments', async (req) => {
    const q = z.object({ business: z.uuid().optional(), supplier: z.uuid().optional(), state: z.string().optional() }).parse(req.query)
    const rows = await ctx.db
      .select()
      .from(payments)
      .where(
        and(
          q.business ? eq(payments.businessId, q.business) : undefined,
          q.supplier ? eq(payments.supplierId, q.supplier) : undefined,
          q.state ? inArray(payments.state, q.state.split(',')) : undefined,
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(200)
    return paymentViews(ctx, rows)
  })
  app.get('/payments/:id', async (req) => paymentView(ctx, await loadPayment((req.params as { id: string }).id)))

  /** Receipt for both parties: amounts, FX, and the transactions on both chains. */
  app.get('/payments/:id/receipt', async (req) => {
    const v = await paymentView(ctx, await loadPayment((req.params as { id: string }).id))
    return {
      receipt: v.id,
      invoiceRef: v.invoiceRef,
      from: v.business.name,
      to: v.supplier.name,
      status: v.label,
      grossUsd: v.amount,
      feeUsd: v.fee,
      netUsd: v.net,
      payout: v.payoutAmount ? `${v.payoutAmount} ${v.payoutCurrency}` : null,
      transactions: v.txs,
      issuedAt: new Date().toISOString(),
    }
  })
  app.get('/payments/:id/pacs008', async (req, reply) => {
    const p = await loadPayment((req.params as { id: string }).id)
    if (!p.pacs008) throw new HttpError(404, 'pacs.008 is generated when the payout starts')
    return reply.type('application/xml').send(p.pacs008)
  })

  // ------------------------------------------------------------ net settlement batches
  app.post('/batches', async (req, reply) => reply.status(201).send(await createBatch(ctx, CreateBatch.parse(req.body))))
  app.post('/batches/:id/sign', async (req, reply) =>
    reply.status(202).send(await signBatch(ctx, (req.params as { id: string }).id, SignBatch.parse(req.body))),
  )

  // ------------------------------------------------------------ ops console
  app.get('/ops/cases', async (req) => {
    ops(req)
    const q = z.object({ status: z.enum(['open', 'resolved']).optional() }).parse(req.query)
    return ctx.db.select().from(opsCases).where(q.status ? eq(opsCases.status, q.status) : undefined).orderBy(desc(opsCases.createdAt)).limit(200)
  })
  app.post('/ops/cases/:id/resolve', async (req) => {
    ops(req)
    const { resolution } = z.object({ resolution: z.string().min(3) }).parse(req.body)
    const [row] = await ctx.db
      .update(opsCases)
      .set({ status: 'resolved', resolution, resolvedAt: new Date() })
      .where(eq(opsCases.id, (req.params as { id: string }).id))
      .returning()
    if (!row) throw new HttpError(404, 'case not found')
    return row
  })
  app.get('/ops/queue', async (req) => {
    ops(req)
    const rows = await ctx.db.select().from(payments).where(inArray(payments.state, ['FROZEN', 'ESCROWED', 'PAYOUT_SENT'])).orderBy(desc(payments.updatedAt))
    return paymentViews(ctx, rows)
  })
  app.get('/ops/health', async (req) => {
    ops(req)
    const [chains, depth, byState, failedHooks] = await Promise.all([
      ctx.gw.health(),
      ctx.queue.depth(),
      ctx.db.select({ state: payments.state, n: sql<number>`count(*)::int` }).from(payments).groupBy(payments.state),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(webhookDeliveries).where(eq(webhookDeliveries.status, 'failed')),
    ])
    return {
      chains,
      queueDepth: depth,
      payments: Object.fromEntries(byState.map((r) => [`${r.state} (${STATE_LABELS[r.state as PaymentState] ?? r.state})`, r.n])),
      failedWebhooks: failedHooks[0]?.n ?? 0,
    }
  })
  app.get('/ops/fees', async (req) => {
    ops(req)
    return ctx.gw.feeVaultBalances()
  })
  app.get('/ops/ledger', async (req) => {
    ops(req)
    const b = await balances(ctx.db)
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString()]))
  })
  app.get('/ops/ledger/:paymentId', async (req) => {
    ops(req)
    const entries = await entriesFor(ctx.db, (req.params as { paymentId: string }).paymentId)
    return entries.map((e) => ({ ...e, lines: e.lines.map((l) => ({ ...l, amount: l.amount.toString() })) }))
  })
  app.post('/ops/reconcile', async (req) => {
    ops(req)
    const r = await runReconciliation(ctx)
    return { mismatches: r.mismatches, reports: r.reports.map((x) => ({ ...x, gross: x.gross.toString(), fees: x.fees.toString(), net: x.net.toString(), refunded: x.refunded.toString() })) }
  })
  app.get('/ops/reports', async (req) => {
    ops(req)
    const rows = await ctx.db.select().from(settlementReports).orderBy(desc(settlementReports.day)).limit(60)
    return rows.map((r) => ({ ...r, gross: r.gross.toString(), fees: r.fees.toString(), net: r.net.toString(), refunded: r.refunded.toString() }))
  })
  app.get('/ops/reports/:id.csv', async (req, reply) => {
    ops(req)
    const [r] = await ctx.db.select().from(settlementReports).where(eq(settlementReports.id, (req.params as { id: string }).id))
    if (!r) throw new HttpError(404, 'report not found')
    return reply.type('text/csv').header('content-disposition', `attachment; filename="settlement-${r.day}-${r.corridor.replace(/[^a-z0-9]+/gi, '_')}.csv"`).send(r.csv)
  })

  /** Local demo only: fast-forward the chain past the escrow's refund window. */
  app.post('/ops/dev/warp', async (req) => {
    ops(req)
    if (ctx.cfg.network.kind !== 'local' || !ctx.gw.warp) throw new HttpError(404, 'only on the local chain')
    const { seconds } = z.object({ seconds: z.number().int().positive().max(30 * 86400) }).parse(req.body)
    await ctx.gw.warp(seconds)
    return { warped: seconds, chainTime: await ctx.gw.now() }
  })

  return app
}
