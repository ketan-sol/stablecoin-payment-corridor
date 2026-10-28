import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { hashTypedData, type Hex, type TypedDataDefinition } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Ctx } from '../src/ctx'
import { quotes } from '../src/db/schema'
import { HttpError } from '../src/errors'
import { onboard } from '../src/services/counterparties'
import { typedDataFor } from '../src/services/intents'
import { createPayment, quotePayment, signPayment } from '../src/services/quote'
import { paymentView } from '../src/services/views'
import { business, FakeGateway, makeCtx, supplierWallet } from './fakes'
import { load, seed } from './helpers'

let ctx: Ctx
let gw: FakeGateway
let close: () => Promise<void>
beforeEach(async () => {
  ;({ ctx, gw, close } = await makeCtx())
})
afterEach(async () => close())

const input = (ids: { businessId: string; supplierId: string }, amountUsd = '1000.00') => ({
  ...ids,
  amountUsd,
  invoiceRef: 'INV-1',
  sourceChain: 'base',
  payoutCurrency: 'INR',
})

const rejects = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(HttpError)
  await expect(p).rejects.toMatchObject({ code })
}

describe('checks before any value moves', () => {
  it('KYB: rejected names never get an attestation; unverified parties cannot be paid', async () => {
    const s = await onboard(ctx, { kind: 'supplier', name: 'Blocked Trading LLC', country: 'IN', wallet: supplierWallet })
    expect(s.kybStatus).toBe('rejected')
    expect(gw.verified.has(supplierWallet.toLowerCase())).toBe(false)
    const b = await onboard(ctx, { kind: 'business', name: 'Acme', country: 'US', wallet: business.address })
    await rejects(createPayment(ctx, input({ businessId: b.id, supplierId: s.id })), 'kyb')
  })

  it('embargoed countries fail KYB', async () => {
    const s = await onboard(ctx, { kind: 'supplier', name: 'Some Co', country: 'KP', wallet: supplierWallet })
    expect(s.kybStatus).toBe('rejected')
  })

  it('sanctions oracle hit at quote time', async () => {
    const ids = await seed(ctx)
    gw.sanctioned.add(supplierWallet.toLowerCase())
    await rejects(createPayment(ctx, input(ids)), 'sanctions')
  })

  it('per-payment and daily limits by tier', async () => {
    const ids = await seed(ctx)
    await rejects(createPayment(ctx, input(ids, '10000.01')), 'limit')
  })

  it('a depeg pauses quoting', async () => {
    const ids = await seed(ctx)
    const p = await createPayment(ctx, input(ids))
    ctx.fx = { ...ctx.fx, usdcUsd: async () => 0.98 }
    await rejects(quotePayment(ctx, p.id), 'depeg')
  })
})

describe('quote', () => {
  it('fee on top (30 bps, 0.50 minimum), FX locked, 60 s expiry, typed data the router will accept', async () => {
    const ids = await seed(ctx)
    const big = await createPayment(ctx, input(ids))
    const q = await quotePayment(ctx, big.id)
    expect(q.fee).toBe('3000000')
    expect(q.amount).toBe('1003000000')
    expect(Number(q.fxRate)).toBeGreaterThan(80)
    expect(new Date(q.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000)
    const td = q.typedData as { primaryType: string; message: { spender: string; witness: { destinationDomain: number } } }
    expect(td.primaryType).toBe('PermitWitnessTransferFrom')
    expect(td.message.spender).toBe(ctx.cfg.network.sources.base.router)
    expect(td.message.witness.destinationDomain).toBe(26)

    const small = await createPayment(ctx, input(ids, '10.00'))
    expect((await quotePayment(ctx, small.id)).fee).toBe('500000') // minimum
  })

  it('permit deadline follows the source chain clock when it runs ahead (Permit2 checks chain time)', async () => {
    const ids = await seed(ctx)
    gw.clock = Math.floor(Date.now() / 1000) + 72 * 3600 // e.g. a local chain fast-forwarded past a refund window
    const p = await createPayment(ctx, input(ids))
    await quotePayment(ctx, p.id)
    expect((await load(ctx, p.id)).deadline!).toBeGreaterThan(gw.clock + 60)
  })

  it('requoting supersedes the old quote', async () => {
    const ids = await seed(ctx)
    const p = await createPayment(ctx, input(ids))
    const q1 = await quotePayment(ctx, p.id)
    await quotePayment(ctx, p.id)
    const [old] = await ctx.db.select().from(quotes).where(eq(quotes.id, q1.quoteId))
    expect(old.status).toBe('superseded')
  })
})

describe('signing', () => {
  async function quoted() {
    const ids = await seed(ctx)
    const p = await createPayment(ctx, input(ids))
    const q = await quotePayment(ctx, p.id)
    const typed = typedDataFor(ctx.cfg, await load(ctx, p.id), business.address, supplierWallet)
    return { p, q, typed }
  }

  it('accepts the sender’s signature once', async () => {
    const { p, q, typed } = await quoted()
    const signature = await business.signTypedData(typed as Parameters<typeof business.signTypedData>[0])
    const signed = await signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature })
    expect(signed.state).toBe('SIGNED')
    await expect(signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature })).rejects.toBeInstanceOf(HttpError)
  })

  it('accepts a contract wallet’s ERC-1271 signature (e.g. a post-quantum smart account)', async () => {
    const { p, q, typed } = await quoted()
    const pqSignature: Hex = `0x${'ab'.repeat(2420)}` // ML-DSA-44 size: no ECDSA involved
    const digest = hashTypedData(typed as unknown as TypedDataDefinition)
    gw.contractWallets.set(business.address.toLowerCase(), (d, sig) => d === digest && sig === pqSignature)

    await rejects(signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature: `0x${'cd'.repeat(2420)}` }), 'signature')
    const signed = await signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature: pqSignature })
    expect(signed.state).toBe('SIGNED')
  })

  it('rejects someone else’s signature before any gas is spent', async () => {
    const { p, q, typed } = await quoted()
    const mallory = privateKeyToAccount(`0x${'99'.repeat(32)}`)
    const signature = await mallory.signTypedData(typed as Parameters<typeof business.signTypedData>[0])
    await rejects(signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature }), 'signature')
    expect(gw.count('pay')).toBe(0)
  })

  it('rejects a tampered quote token and an expired quote', async () => {
    const { p, q, typed } = await quoted()
    const signature = await business.signTypedData(typed as Parameters<typeof business.signTypedData>[0])
    await expect(signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: 'ab'.repeat(32), signature })).rejects.toBeInstanceOf(HttpError)
    await ctx.db.update(quotes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(quotes.id, q.quoteId))
    await rejects(signPayment(ctx, p.id, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature }), 'quote_expired')
    expect((await paymentView(ctx, await load(ctx, p.id))).label).toBe('Quote expired')
  })
})
