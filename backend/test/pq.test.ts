import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionData, parseAbiItem, stringToHex } from 'viem'
import { erc1271, execute, keygen } from '../scripts/pq-key'
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

describe('pq-key tool (officers, admin proposer, PQ wallets)', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'pqkey-')), 'k.json')
  const account = '0x00000000000000000000000000000000000000aa' as const
  const escrow = '0x00000000000000000000000000000000000000bb' as const

  it('keygen writes a private key file and never overwrites one', () => {
    const path = tmp()
    const k = keygen(path, 2)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(k.root).toBe(new PQSigner(k.secret, k.seed, 2).root)
    expect(() => keygen(path, 2)).toThrow(/refusing to overwrite/)
  })

  it('execute: burns the leaf on disk first, and signs exactly the PQAccount call', () => {
    const path = tmp()
    const k = keygen(path, 2)
    const key = `0x${'cd'.repeat(32)}` as const
    const r = execute({ key: path, account, chainId: 5042002, to: escrow, fn: 'refund(bytes32)', args: [key], deadline: 1000n })
    expect(r.leaf).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8')).next).toBe(1)

    const { args } = decodeFunctionData({ abi: [parseAbiItem('function execute(address,bytes,uint256,(uint256,bytes32[67],bytes32[]))')], data: r.data })
    const inner = encodeFunctionData({ abi: [parseAbiItem('function refund(bytes32)')], args: [key] })
    expect(args[0]).toBe(escrow)
    expect(args[1]).toBe(inner)
    const expected = new PQSigner(k.secret, k.seed, 2).sign(0, executeDigest(5042002, account, escrow, inner, 1000n))
    expect(args[3]).toEqual([expected.leaf, expected.wots, expected.path])

    expect(execute({ key: path, account, chainId: 5042002, to: escrow, fn: 'refund(bytes32)', args: [key], deadline: 1000n }).leaf).toBe(1)
  })

  it('stops when the tree is used up', () => {
    const path = tmp()
    keygen(path, 1)
    erc1271({ key: path, account, chainId: 1, hash: `0x${'01'.repeat(32)}` })
    erc1271({ key: path, account, chainId: 1, hash: `0x${'02'.repeat(32)}` })
    expect(() => erc1271({ key: path, account, chainId: 1, hash: `0x${'03'.repeat(32)}` })).toThrow(/rotate/)
  })
})
