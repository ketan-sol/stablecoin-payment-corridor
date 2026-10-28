import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { loadConfig } from '../src/config'
import type { Ctx } from '../src/ctx'
import { digits, executeDigest, PQSigner, reserveLeaf } from '../src/pq'
import { makeCtx } from './fakes'

let ctx: Ctx
let close: () => Promise<void>
beforeEach(async () => {
  ;({ ctx, close } = await makeCtx())
})
afterEach(async () => close())

const b32 = (s: string) => stringToHex(s, { size: 32 })

describe('post-quantum signer (PQAccount)', () => {
  // Same values as contracts/test/PQAccount.t.sol test_vector_matchesBackendSigner: both sides make identical bytes.
  it('matches the Solidity signer and contract byte for byte', () => {
    const s = new PQSigner(b32('secret'), b32('seed'), 3)
    expect(s.root).toBe('0x8cce66d1d45e92d57c6b2f7c557fad67f4747e4acffe38a2e20f4792a1b2f56b')
    const sig = s.sign(5, b32('message'))
    expect(sig.leaf).toBe(5n)
    expect(sig.wots[0]).toBe('0x74c885817cb0f16b238ecdfb1ac92d583fb7d0ae5c59691468e8ed388a2ecbb6')
    expect(sig.wots[66]).toBe('0x4343b23096ab7351ea8d264351388cea0a5c24445d72e674c6891d2125c09199')
    expect(sig.path[0]).toBe('0x81a6f02a2fa6ad50d9e93b5a148a48ecdf9d347c2b76857288a4ccc5d681e3a9')
    expect(executeDigest(31337, '0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb', '0x1234', 1000n)).toBe(
      '0xcec053d3d0b6d360ec8756b71ea364636d98aa5edb7a86fdda15d194f8035661',
    )
  })

  it('checksum digits: all-zero message has the maximum checksum 960 = 0x3c0', () => {
    expect(digits(new Uint8Array(32)).slice(64)).toEqual([3, 12, 0])
    expect(digits(new Uint8Array(32).fill(0xff)).slice(64)).toEqual([0, 0, 0])
  })

  it('refuses a leaf outside the tree instead of reusing one', () => {
    const s = new PQSigner(b32('secret'), b32('seed'), 2)
    expect(() => s.sign(4, b32('m'))).toThrow(/exhausted/)
  })

  it('hands out each leaf once, even to concurrent senders, per key tree', async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => reserveLeaf(ctx.db, '0xroot1')))
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(await reserveLeaf(ctx.db, '0xroot2')).toBe(0) // a rotated tree starts over
    expect(await reserveLeaf(ctx.db, '0xroot1')).toBe(20)
  })

  it('config: PQ_ACCOUNT needs its key', () => {
    const env = { PQ_ACCOUNT: '0x00000000000000000000000000000000000000aa' }
    expect(() => loadConfig(env)).toThrow(/PQ_SECRET/)
    const cfg = loadConfig({ ...env, PQ_SECRET: `0x${'01'.repeat(32)}`, PQ_SEED: `0x${'02'.repeat(32)}`, PQ_HEIGHT: '12' })
    expect(cfg.pq).toMatchObject({ height: 12 })
    expect(loadConfig({}).pq).toBeNull()
  })
})
