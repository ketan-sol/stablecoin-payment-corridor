import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Hex } from 'viem'
import { opsCases, paymentEvents } from '../src/db/schema'
import { advance } from '../src/services/orchestrator'
import { business, FakeGateway, makeCtx, supplierWallet } from './fakes'
import { balances, drive, ledgerSum, load, seed, seedSecondSupplier, signedBatch, signedPayment } from './helpers'
import type { Ctx } from '../src/ctx'

let ctx: Ctx
let gw: FakeGateway
let close: () => Promise<void>

beforeEach(async () => {
  ;({ ctx, gw, close } = await makeCtx())
})
afterEach(async () => close())

const states = async (id: string) =>
  (await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, id)).orderBy(paymentEvents.id)).map((e) => e.toState)

describe('happy path (demo 1–3)', () => {
  it('wallet payout: every state in order, ledger balanced and settled', async () => {
    const ids = await seed(ctx)
    const id = await signedPayment(ctx, ids)
    expect(await drive(ctx, id)).toBe('COMPLETED')
    expect(await states(id)).toEqual([
      'CREATED', 'QUOTED', 'SIGNED', 'FUNDED_SOURCE', 'IN_TRANSIT', 'ESCROWED', 'COMPLIANCE_CLEARED', 'PAYOUT_SENT', 'COMPLETED',
    ])
    const p = await load(ctx, id)
    expect(p.net).toBe(1_000_000_000n) // the supplier gets the invoice amount
    expect(p.fee).toBe(3_000_000n) // 30 bps on top
    expect(p.amount).toBe(1_003_000_000n)
    expect(p.pacs008).toContain('<IntrBkSttlmAmt Ccy="USD">1000.00</IntrBkSttlmAmt>')

    expect(await ledgerSum(ctx)).toBe(0n)
    const b = await balances(ctx.db)
    expect(b.escrow).toBe(0n)
    expect(b.in_transit).toBe(0n)
    expect(b.fees).toBe(3_000_000n)
    expect(b[`payout:${p.supplierId}`]).toBe(1_000_000_000n)
    expect(b[`sender:${business.address.toLowerCase()}`]).toBe(-1_003_000_000n)
    expect(gw.count('pay')).toBe(1)
    expect(gw.count('receivePayment')).toBe(1)
    expect(gw.count('release')).toBe(1)
  })

  it('bank payout: off-ramp pays fiat, escrow reimburses it', async () => {
    const id = await signedPayment(ctx, await seed(ctx, { payoutMethod: 'bank' }))
    expect(await drive(ctx, id)).toBe('COMPLETED')
    const p = await load(ctx, id)
    expect(p.payoutMethod).toBe('bank')
    expect(p.payoutRef).toMatch(/^bank_/)
    expect(gw.escrow.get(p.escrowKey as Hex)!.status).toBe('Released')
  })
})

describe('failure and refund paths', () => {
  it('demo 5: off-ramp fails → refund after the window, exactly once, pulled by the sender', async () => {
    const id = await signedPayment(ctx, await seed(ctx, { payoutMethod: 'bank', account: 'FAIL-0001' }))
    expect(await drive(ctx, id)).toBe('PAYOUT_SENT') // waiting out the window
    expect((await ctx.db.select().from(opsCases)).map((c) => c.kind)).toEqual(['payout'])

    gw.clock += gw.window
    expect(await drive(ctx, id)).toBe('REFUNDED')
    expect(gw.count('claimRefund')).toBe(1)
    expect(await drive(ctx, id)).toBe('REFUNDED')
    expect(gw.count('claimRefund')).toBe(1)
    const b = await balances(ctx.db)
    expect(b[`refunds:${business.address.toLowerCase()}`]).toBe(1_000_000_000n)
    expect(b.escrow).toBe(0n)
    expect(await ledgerSum(ctx)).toBe(0n)
  })

  it('demo 4: sanctioned receiver → frozen on-chain, ops case, two officers refund', async () => {
    const ids = await seed(ctx)
    const id = await signedPayment(ctx, ids)
    gw.sanctioned.add(supplierWallet.toLowerCase()) // listed after the quote, caught at the release gate
    expect(await drive(ctx, id)).toBe('FROZEN')
    const p = await load(ctx, id)
    expect(gw.escrow.get(p.escrowKey as Hex)!.status).toBe('Frozen')
    expect(gw.count('release')).toBe(0)
    const [c] = await ctx.db.select().from(opsCases)
    expect(c.kind).toBe('compliance')

    gw.officersRefund(p.escrowKey as Hex) // from the ops console, two officers
    expect(await drive(ctx, id)).toBe('REFUNDED')
    expect(await ledgerSum(ctx)).toBe(0n)
  })

  it('false positive: officers unfreeze → compliance re-checked without the name hit → paid', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    // Name screening flags the supplier only after onboarding (a list update).
    ctx.vendor = { ...ctx.vendor, screenName: async (n) => ({ hit: n.startsWith('Supplier'), list: 'OFAC SDN (sandbox)' }) }
    expect(await drive(ctx, id)).toBe('FROZEN')
    const p = await load(ctx, id)
    gw.officersUnfreeze(p.escrowKey as Hex)
    expect(await drive(ctx, id)).toBe('COMPLETED')
  })

  it('a release that reverts goes back through the compliance gate', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    gw.holdReceipts = true
    await advance(ctx, id) // pay sent, pending
    gw.mine()
    gw.holdReceipts = false
    // Sanction lands between the compliance check and the release.
    const realRelease = gw.release.bind(gw)
    gw.release = async (k, to) => {
      gw.sanctioned.add(supplierWallet.toLowerCase())
      return realRelease(k, to)
    }
    expect(await drive(ctx, id)).toBe('FROZEN')
  })
})

describe('net settlement', () => {
  it('one signature, one burn, one delivery; each supplier paid on its own', async () => {
    const ids = await seed(ctx)
    const s2 = await seedSecondSupplier(ctx)
    const legs = await signedBatch(ctx, ids.businessId, [ids.supplierId, s2])
    for (const id of legs) await drive(ctx, id)
    for (const id of legs) expect(await drive(ctx, id)).toBe('COMPLETED')
    expect(gw.count('payBatch')).toBe(1)
    expect(gw.count('receivePayment')).toBe(1)
    expect(gw.count('release')).toBe(2)
    const b = await balances(ctx.db)
    expect(b.fees).toBe(900_000n) // 30 bps of 300 USD (above the 0.50 minimum)
    expect(await ledgerSum(ctx)).toBe(0n)
  })
})

describe('chaos (the plan: kill the relayer, delay attestations, duplicate jobs)', () => {
  it('relayer dies after sending pay: the restart waits for that transaction, never sends a second', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    gw.holdReceipts = true
    await advance(ctx, id) // pay sent; "crash" here
    expect((await load(ctx, id)).state).toBe('SIGNED')
    await advance(ctx, id) // restart: still pending, no resend
    expect(gw.count('pay')).toBe(1)
    gw.mine()
    gw.holdReceipts = false
    expect(await drive(ctx, id)).toBe('COMPLETED')
    expect(gw.count('pay')).toBe(1)
  })

  it('attestation delayed: stays in transit, then completes; never double-mints', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    gw.attestationReady = false
    expect(await drive(ctx, id)).toBe('IN_TRANSIT')
    gw.attestationReady = true
    expect(await drive(ctx, id)).toBe('COMPLETED')
    expect(gw.count('receivePayment')).toBe(1)
  })

  it('duplicate concurrent jobs move the payment once and post each entry once', async () => {
    const id = await signedPayment(ctx, await seed(ctx))
    await Promise.all([advance(ctx, id), advance(ctx, id), advance(ctx, id)])
    await drive(ctx, id)
    expect((await load(ctx, id)).state).toBe('COMPLETED')
    const b = await balances(ctx.db)
    expect(b.fees).toBe(3_000_000n)
    expect(await ledgerSum(ctx)).toBe(0n)
  })

  it('a relay that reverts returns to the quote; nothing moved', async () => {
    const ids = await seed(ctx)
    const id = await signedPayment(ctx, ids)
    gw.pay = async () => {
      const { ChainRevert } = await import('../src/errors')
      throw new ChainRevert('InvalidSigner')
    }
    expect(await drive(ctx, id)).toBe('QUOTED')
    expect((await load(ctx, id)).lastError).toContain('InvalidSigner')
    expect(await ledgerSum(ctx)).toBe(0n)
  })
})
