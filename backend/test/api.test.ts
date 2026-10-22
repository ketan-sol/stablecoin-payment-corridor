import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { reviveTypedData } from '@corridor/shared'
import { buildApi } from '../src/api'
import type { Ctx } from '../src/ctx'
import { business, makeCtx, supplierWallet } from './fakes'
import { drive } from './helpers'

let ctx: Ctx
let app: FastifyInstance
let close: () => Promise<void>
beforeEach(async () => {
  ;({ ctx, close } = await makeCtx())
  app = buildApi(ctx)
})
afterEach(async () => {
  await app.close()
  await close()
})

const json = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload: payload as object, headers })
  return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body }
}

describe('HTTP API', () => {
  it('config tells clients the chains, contracts and currencies', async () => {
    const { status, body } = await json('GET', '/config')
    expect(status).toBe(200)
    expect(body.settlement.domain).toBe(26)
    expect(body.sources.map((s: { key: string }) => s.key)).toEqual(['base'])
    expect(body.payoutCurrencies).toContain('INR')
  })

  it('full flow: onboard both sides, create, quote, sign the returned typed data, settle, receipts', async () => {
    const b = await json('POST', '/businesses', { name: 'Acme Inc', country: 'US', wallet: business.address })
    expect(b.status).toBe(201)
    expect(b.body.kybStatus).toBe('verified')
    const s = await json('POST', '/suppliers', { name: 'Supplier Pvt Ltd', country: 'IN', wallet: supplierWallet, payoutMethod: 'wallet' })
    expect(s.body.kybStatus).toBe('verified')

    const created = await json('POST', '/payments', {
      businessId: b.body.id,
      supplierId: s.body.id,
      amountUsd: '1000.00',
      invoiceRef: 'INV-2026-0042',
      sourceChain: 'base',
      payoutCurrency: 'INR',
    })
    expect(created.status).toBe(201)
    expect(created.body.label).toBe('Draft')

    const q = await json('POST', `/payments/${created.body.id}/quote`)
    expect(q.status).toBe(200)
    // What a wallet gets: JSON typed data. Revive the integers and sign it, as the sender app does with wagmi.
    const signature = await business.signTypedData(reviveTypedData(q.body.typedData) as Parameters<typeof business.signTypedData>[0])
    const signed = await json('POST', `/payments/${created.body.id}/sign`, { quoteId: q.body.quoteId, quoteToken: q.body.quoteToken, signature })
    expect(signed.status).toBe(202)
    expect(signed.body.state).toBe('SIGNED')

    await drive(ctx, created.body.id)
    const view = await json('GET', `/payments/${created.body.id}`)
    expect(view.body.state).toBe('COMPLETED')
    expect(view.body.label).toBe('Paid out')
    expect(view.body.txs.map((t: { label: string }) => t.label)).toEqual(['Funds sent', 'Minted into escrow', 'Released to supplier'])
    expect(view.body.txs[0].url).toMatch(/^https:\/\/explorer\.test\/tx\/0x/)

    const receipt = await json('GET', `/payments/${created.body.id}/receipt`)
    expect(receipt.body.status).toBe('Paid out')
    const xml = await app.inject({ method: 'GET', url: `/payments/${created.body.id}/pacs008` })
    expect(xml.headers['content-type']).toContain('application/xml')
    expect(xml.body).toContain('<FIToFICstmrCdtTrf>')

    const list = await json('GET', `/payments?business=${b.body.id}`)
    expect(list.body).toHaveLength(1)
  })

  it('validation and not-found errors are clean 4xx', async () => {
    expect((await json('POST', '/businesses', { name: 'X', country: 'USA', wallet: '0x1' })).status).toBe(400)
    expect((await json('GET', '/payments/not-a-uuid')).status).toBe(404)
    expect((await json('POST', '/payments', { businessId: crypto.randomUUID(), supplierId: crypto.randomUUID(), amountUsd: '1.234', invoiceRef: 'x', sourceChain: 'base', payoutCurrency: 'INR' })).status).toBe(400)
  })

  it('ops routes need the ops token', async () => {
    expect((await json('GET', '/ops/health')).status).toBe(401)
    const ok = await json('GET', '/ops/health', undefined, { 'x-ops-token': 'test-ops-token' })
    expect(ok.status).toBe(200)
    expect(ok.body.chains[0].ok).toBe(true)
    const recon = await json('POST', '/ops/reconcile', {}, { 'x-ops-token': 'test-ops-token' })
    expect(recon.body.mismatches).toEqual([])
  })
})
