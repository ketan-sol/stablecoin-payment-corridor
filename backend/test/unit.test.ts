import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { hashTypedData, type Hex } from 'viem'
import { canonicalJson, paymentTypedData, travelRuleHash, type TravelRulePayload } from '@corridor/shared'
import { loadConfig } from '../src/config'
import type { Ctx } from '../src/ctx'
import { opsCases, webhookDeliveries, counterparties } from '../src/db/schema'
import { decrypt, encrypt, hmac } from '../src/crypto'
import { credit, debit, post, UnbalancedEntry } from '../src/ledger'
import { pacs008 } from '../src/services/iso20022'
import { bps, convert, formatUnits6, parseUnits6 } from '../src/services/money'
import { reconcile, settlementReport } from '../src/services/reconciliation'
import { deliverWebhook } from '../src/services/webhooks'
import { FakeGateway, makeCtx } from './fakes'
import { drive, load, seed, signedPayment } from './helpers'

let ctx: Ctx
let gw: FakeGateway
let close: () => Promise<void>
beforeEach(async () => {
  ;({ ctx, gw, close } = await makeCtx())
})
afterEach(async () => close())

describe('money: 6 decimals everywhere', () => {
  it('parses, formats, takes bps and converts without floats', () => {
    expect(parseUnits6('1000.5')).toBe(1_000_500_000n)
    expect(() => parseUnits6('1.0000001')).toThrow()
    expect(() => parseUnits6('-1')).toThrow()
    expect(formatUnits6(1_234_567n)).toBe('1.23')
    expect(bps(1_000_000_000n, 30)).toBe(3_000_000n)
    expect(convert(1_000_000_000n, '83.20000000')).toBe('83200.00')
  })
})

describe('testnet config', () => {
  const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
  const env = {
    NETWORK: 'testnet',
    RELAYER_KEY: `0x${'22'.repeat(32)}`,
    TRAVEL_RULE_KEY: `0x${'33'.repeat(32)}`,
    ROUTER: a(1),
    FEE_VAULT: a(2),
    ESCROW: a(3),
    REGISTRY: a(4),
    OFF_RAMP: a(5),
  }

  it('enables only the source chains a router is deployed on', () => {
    expect(Object.keys(loadConfig(env).network.sources)).toEqual(['baseSepolia'])
    expect(Object.keys(loadConfig({ ...env, SOURCE_CHAINS: 'baseSepolia, sepolia' }).network.sources)).toEqual(['baseSepolia', 'sepolia'])
    expect(() => loadConfig({ ...env, SOURCE_CHAINS: 'tron' })).toThrow(/unknown chain tron/)
  })

  it('takes per-chain router and fee vault addresses (non-CREATE2 deploys)', () => {
    const { ROUTER: _r, FEE_VAULT: _f, ...rest } = env
    const cfg = loadConfig({ ...rest, SOURCE_CHAINS: 'sepolia', SEPOLIA_ROUTER: a(7), SEPOLIA_FEE_VAULT: a(8) })
    expect(cfg.network.sources.sepolia.router).toBe(a(7))
    expect(cfg.network.sources.sepolia.feeVault).toBe(a(8))
    expect(cfg.network.sources.sepolia.domain).toBe(0)
    // Base Sepolia isn't enabled, so its missing addresses don't matter; enabling it without them fails.
    expect(() => loadConfig({ ...rest, SOURCE_CHAINS: 'sepolia,baseSepolia', SEPOLIA_ROUTER: a(7), SEPOLIA_FEE_VAULT: a(8) })).toThrow(/BASE_SEPOLIA_ROUTER/)
  })

  it('refuses to start without its keys and addresses', () => {
    expect(() => loadConfig({ ...env, RELAYER_KEY: undefined })).toThrow(/RELAYER_KEY/)
    expect(() => loadConfig({ ...env, ESCROW: undefined })).toThrow(/ESCROW/)
  })
})

describe('ledger', () => {
  it('refuses an unbalanced entry', async () => {
    await expect(post(ctx.db, { kind: 'x', token: 'USDC', lines: [debit('a', 5n), credit('b', 4n)] })).rejects.toBeInstanceOf(UnbalancedEntry)
    await expect(post(ctx.db, { kind: 'x', token: 'USDC', lines: [debit('a', 5n)] })).rejects.toBeInstanceOf(UnbalancedEntry)
  })
})

describe('Travel Rule', () => {
  const payload: TravelRulePayload = {
    originator: { name: 'Acme', accountNumber: '0xabc', country: 'US' },
    beneficiary: { name: 'Müller GmbH', accountNumber: '0xdef', country: 'DE' },
    invoiceRef: 'INV-1',
    amount: { value: '10.00', currency: 'USD' },
  }
  it('hash ignores key order; payload round-trips through AES-GCM', () => {
    const reordered = JSON.parse(JSON.stringify({ amount: payload.amount, invoiceRef: 'INV-1', beneficiary: payload.beneficiary, originator: payload.originator }))
    expect(travelRuleHash(reordered)).toBe(travelRuleHash(payload))
    expect(canonicalJson(payload)).toContain('"Müller GmbH"')
    const key = ctx.cfg.travelRuleKey
    const blob = encrypt(key, JSON.stringify(payload))
    expect(JSON.parse(decrypt(key, blob))).toEqual(payload)
    expect(() => decrypt(`0x${'33'.repeat(32)}`, blob)).toThrow()
  })
})

describe('typed data', () => {
  it('matches the digest the Solidity tests sign (PaymentSig) for a fixed vector', () => {
    // Same construction as contracts/test/utils/PaymentSig.sol: Permit2 domain + PermitWitnessTransferFrom(PaymentIntent).
    const td = paymentTypedData(
      { chainId: 31337, permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', router: '0x0000000000000000000000000000000000007007' },
      { permitted: { token: '0x00000000000000000000000000000000000005dc', amount: 1_003_000_000n }, nonce: 7n, deadline: 1_800_000_000n },
      { paymentId: `0x${'ab'.repeat(32)}`, receiver: '0x5000000000000000000000000000000000000002', refundTo: '0x5000000000000000000000000000000000000001', fee: 3_000_000n, destinationDomain: 26, travelRuleHash: `0x${'cd'.repeat(32)}` },
    )
    // contracts/test/TypedDataVector.t.sol computes this with the real Permit2 and PaymentRouter.hashIntent.
    expect(hashTypedData(td)).toBe('0x793ad616e298d1c55d3432ad6165a19384d4bd83eaa04b644e66312155903035')
    expect(td.types.PermitWitnessTransferFrom.at(-1)).toEqual({ name: 'witness', type: 'PaymentIntent' })
  })
})

describe('ISO 20022 pacs.008', () => {
  it('maps the payment and escapes names', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    await drive(ctx, id)
    const p = await load(ctx, id)
    const [debtor] = await ctx.db.select().from(counterparties).where(eq(counterparties.id, p.businessId))
    const xml = pacs008(p, { ...debtor, name: 'Acme & <Co>' }, debtor)
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08')
    expect(xml).toContain('<Nm>Acme &amp; &lt;Co&gt;</Nm>')
    expect(xml).toContain(`<UETR>${p.id}</UETR>`)
    expect(xml).toContain(`<SourceBurn>${p.payTx}</SourceBurn>`)
    expect(xml.match(/<EndToEndId>(.*)<\/EndToEndId>/)![1].length).toBeLessThanOrEqual(35)
  })
})

describe('webhooks', () => {
  it('signed delivery; a retry after success is a no-op', async () => {
    const ids = await seed(ctx)
    await ctx.db.update(counterparties).set({ webhookUrl: 'https://hooks.test/corridor' }).where(eq(counterparties.id, ids.businessId))
    await signedPayment(ctx, ids)
    const [d] = await ctx.db.select().from(webhookDeliveries)
    const seen: { headers: Record<string, string>; body: string }[] = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    await deliverWebhook(ctx, d.id, fakeFetch)
    await deliverWebhook(ctx, d.id, fakeFetch) // duplicate
    expect(seen).toHaveLength(1)
    const [{ secret }] = await ctx.db.select({ secret: counterparties.webhookSecret }).from(counterparties).where(eq(counterparties.id, ids.businessId))
    const h = seen[0].headers
    expect(h['x-corridor-signature']).toBe(hmac(secret!, `${h['x-corridor-timestamp']}.${seen[0].body}`))
    expect(h['x-corridor-delivery']).toBe(d.id)
  })

  it('retries with backoff, then gives up', async () => {
    const ids = await seed(ctx)
    await ctx.db.update(counterparties).set({ webhookUrl: 'https://hooks.test/down' }).where(eq(counterparties.id, ids.businessId))
    await signedPayment(ctx, ids)
    const [d] = await ctx.db.select().from(webhookDeliveries)
    const down = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    for (let i = 0; i < 6; i++) await deliverWebhook(ctx, d.id, down)
    const [after] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d.id))
    expect(after.status).toBe('failed')
    expect(after.attempts).toBe(6)
  })
})

describe('reconciliation', () => {
  it('clean ledger and chain agree; settlement report per corridor', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    await drive(ctx, id)
    expect(await reconcile(ctx)).toEqual([])
    const [r] = await settlementReport(ctx, new Date().toISOString().slice(0, 10))
    expect(r.corridor).toBe('base->arc:INR')
    expect(r.payments).toBe(1)
    expect(r.csv.split('\n')[0]).toMatch(/^payment_id,invoice_ref,state/)
    expect(r.matched).toBe(true)
  })

  it('a chain/ledger mismatch opens one ops case', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    await drive(ctx, id)
    const p = await load(ctx, id)
    gw.escrow.get(p.escrowKey as Hex)!.status = 'Refunded' // the chain disagrees with COMPLETED
    const m1 = await reconcile(ctx)
    await reconcile(ctx)
    expect(m1.map((m) => m.title)).toContain('Escrow says Refunded, ledger says COMPLETED')
    const cases = await ctx.db.select().from(opsCases).where(eq(opsCases.kind, 'reconciliation'))
    expect(cases.filter((c) => c.paymentId === p.id)).toHaveLength(1)
  })
})
