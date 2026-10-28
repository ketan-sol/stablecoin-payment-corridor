import { hashTypedData, keccak256, stringToHex, verifyTypedData, type Address, type Hash, type Hex, type TypedDataDefinition } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { escrowKey } from '@corridor/shared'
import type { Config, Network } from '../src/config'
import type { Ctx } from '../src/ctx'
import { openDb } from '../src/db'
import type { EscrowRecord, Gateway, Receipt } from '../src/chain/gateway'
import { ChainRevert } from '../src/errors'
import type { JobQueue } from '../src/queue'
import { mockFx } from '../src/services/fx'
import { sandboxVendor } from '../src/services/vendor'

export const businessKey: Hex = `0x${'b1'.repeat(32)}`
export const business = privateKeyToAccount(businessKey)
export const supplierWallet: Address = '0x5000000000000000000000000000000000000002'
export const supplier2Wallet: Address = '0x5000000000000000000000000000000000000003'

const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

export function testNetwork(): Network {
  const common = { chainId: 31337, rpcUrl: 'http://fake', feeVault: ADDR(0xfee), explorer: 'https://explorer.test' }
  return {
    kind: 'local',
    settlement: { name: 'Arc (test)', chainId: 31337, rpcUrl: 'http://fake', domain: 26, escrow: ADDR(0xe5c0), registry: ADDR(0x9e9), usdc: ADDR(0x05dc), explorer: 'https://arcscan.test' },
    sources: {
      base: { ...common, key: 'base', name: 'Base (test)', kind: 'evm', domain: 6, router: ADDR(0x7007), token: ADDR(0x05dc), tokenSymbol: 'USDC', permit2: ADDR(0x9e72) },
    },
    offRamp: ADDR(0x0ff),
  }
}

export function testConfig(overrides: Partial<Config['env']> = {}): Config {
  return {
    env: {
      NETWORK: 'local',
      PORT: 0,
      PGLITE_DIR: 'memory://',
      SOURCE_CHAINS: 'baseSepolia',
      OPS_TOKEN: 'test-ops-token',
      QUOTE_SECRET: 'test-quote-secret-0123456789',
      QUOTE_TTL_SEC: 60,
      FEE_BPS_STANDARD: 30,
      FEE_BPS_PREMIUM: 15,
      MIN_FEE_USD: '0.50',
      LIMIT_PER_PAYMENT_STANDARD: '10000',
      LIMIT_DAILY_STANDARD: '50000',
      LIMIT_PER_PAYMENT_PREMIUM: '100000',
      LIMIT_DAILY_PREMIUM: '500000',
      POLL_MS: 10,
      IRIS_URL: 'http://iris.test',
      BANK_SETTLE_MS: 0,
      LOCAL_RPC_URL: 'http://fake',
      LOCAL_DEPLOYMENT: 'unused',
      SEPOLIA_RPC_URL: '',
      BASE_SEPOLIA_RPC_URL: '',
      ARC_RPC_URL: '',
      PQ_HEIGHT: 10,
      ...overrides,
    },
    network: testNetwork(),
    relayerKey: `0x${'11'.repeat(32)}`,
    travelRuleKey: `0x${'22'.repeat(32)}`,
    confirmations: 0,
    pq: null,
  }
}

/** Records jobs instead of running them: tests drive `advance` themselves, step by step. */
export class RecordingQueue implements JobQueue {
  jobs: { name: string; data: Record<string, unknown> }[] = []
  async add(name: string, data: Record<string, unknown>) {
    this.jobs.push({ name, data })
  }
  process() {}
  async depth() {
    return this.jobs.length
  }
  async close() {}
}

interface PayRecord {
  source: string
  legs: { paymentId: Hex; receiver: Address; amount: bigint }[]
  sender: Address
  refundTo: Address
}

/** In-memory stand-in for the chains, Circle and the contracts, behaving the way the contracts do. */
export class FakeGateway implements Gateway {
  escrow = new Map<Hex, EscrowRecord>()
  receipts = new Map<Hash, Receipt>()
  verified = new Set<string>()
  sanctioned = new Set<string>()
  refundable = new Map<string, bigint>()
  messages = new Map<Hex, PayRecord>()
  delivered = new Set<Hex>()
  calls: string[] = []
  clock = 1_000_000
  window = 72 * 3600
  block = 100
  attestationReady = true
  /** Next sends land as pending until `mine()`. */
  holdReceipts = false
  cctpFee = 0n
  /** Contract wallets by lowercase address: their ERC-1271 check, given the EIP-712 digest. */
  contractWallets = new Map<string, (digest: Hex, signature: Hex) => boolean>()
  private n = 0

  private tx(name: string, status: 'success' | 'reverted' = 'success'): Hash {
    this.calls.push(name)
    const hash = keccak256(stringToHex(`${name}:${++this.n}`))
    this.receipts.set(hash, this.holdReceipts ? { status: 'pending' } : { status, blockNumber: ++this.block, blockHash: hash, logs: [] })
    return hash
  }
  mine() {
    for (const [h, r] of this.receipts) if (r.status === 'pending') this.receipts.set(h, { status: 'success', blockNumber: ++this.block, blockHash: h, logs: [] })
  }
  count = (name: string) => this.calls.filter((c) => c === name).length

  // ---- reads
  async receipt(_c: string, hash: Hash) {
    return this.receipts.get(hash) ?? { status: 'pending' as const }
  }
  async blockNumber() {
    return this.block
  }
  async now(_chain?: string) {
    return this.clock
  }
  async logs() {
    return []
  }
  async verifyTypedData(_c: string, signer: Address, typedData: TypedDataDefinition, signature: Hex) {
    const wallet = this.contractWallets.get(signer.toLowerCase())
    if (wallet) return wallet(hashTypedData(typedData), signature)
    return verifyTypedData({ ...typedData, address: signer, signature }).catch(() => false)
  }
  async escrowPayment(key: Hex): Promise<EscrowRecord> {
    return this.escrow.get(key) ?? { status: 'None', token: ADDR(0), sender: ADDR(0), receiver: ADDR(0), refundTo: ADDR(0), amount: 0n, escrowedAt: 0 }
  }
  async refundWindow() {
    return this.window
  }
  async totalHeld() {
    let held = 0n
    for (const r of this.escrow.values()) if (r.status === 'Escrowed' || r.status === 'Frozen') held += r.amount
    for (const v of this.refundable.values()) held += v
    return held
  }
  async isVerified(a: Address) {
    return this.verified.has(a.toLowerCase())
  }
  async isSanctioned(a: Address) {
    return this.sanctioned.has(a.toLowerCase())
  }
  async isAllowed(a: Address, b: Address) {
    return (await this.isVerified(a)) && (await this.isVerified(b)) && !(await this.isSanctioned(a)) && !(await this.isSanctioned(b))
  }
  async setAttestation(a: Address) {
    this.verified.add(a.toLowerCase())
    return this.tx('setAttestation')
  }

  // ---- source chains
  private burn(source: string, legs: PayRecord['legs'], sender: Address, refundTo: Address, name: string) {
    const hash = this.tx(name)
    const message = keccak256(stringToHex(`msg:${hash}`))
    const rec = { source, legs, sender, refundTo }
    this.messages.set(message, rec)
    this.messages.set(hash as Hex, rec) // look up by pay tx too
    return hash
  }
  async pay(source: string, intent: { paymentId: Hex; receiver: Address; refundTo: Address; fee: bigint }, permit: { permitted: { amount: bigint } }, sender: Address) {
    if (permit.permitted.amount <= intent.fee) throw new ChainRevert('FeeTooHigh')
    return this.burn(source, [{ paymentId: intent.paymentId, receiver: intent.receiver, amount: permit.permitted.amount - intent.fee }], sender, intent.refundTo, 'pay')
  }
  async payBatch(source: string, batch: { legs: PayRecord['legs']; refundTo: Address }, _p: unknown, sender: Address) {
    return this.burn(source, batch.legs, sender, batch.refundTo, 'payBatch')
  }
  async cctpMessage(_s: string, payTx: Hash) {
    for (const [m, rec] of this.messages) if (m !== payTx && this.messages.get(payTx) === rec) return m
    return null
  }
  async attestation(_s: string, _tx: Hash, message: Hex) {
    return this.attestationReady ? { message, attestation: '0xa77e' as Hex } : null
  }

  // ---- settlement chain
  async receivePayment(message: Hex) {
    if (this.delivered.has(message)) throw new ChainRevert('Nonce already used')
    const rec = this.messages.get(message)
    if (!rec) throw new ChainRevert('unknown message')
    this.delivered.add(message)
    const domain = this.sourceDomain(rec.source)
    for (const [i, l] of rec.legs.entries()) {
      const amount = rec.legs.length === 1 ? l.amount - this.cctpFee : l.amount
      this.escrow.set(escrowKey(domain, l.paymentId), { status: 'Escrowed', token: ADDR(0x05dc), sender: rec.sender, receiver: l.receiver, refundTo: rec.refundTo, amount, escrowedAt: this.clock })
      void i
    }
    return this.tx('receivePayment')
  }
  sourceDomain = (key: string) => testNetwork().sources[key].domain
  async release(key: Hex, to: Address) {
    const r = this.escrow.get(key)
    if (!r || r.status !== 'Escrowed') throw new ChainRevert('BadStatus')
    if (to !== r.receiver && to !== testNetwork().offRamp) throw new ChainRevert('BadPayoutAddress')
    if (!(await this.isAllowed(r.sender, r.receiver))) throw new ChainRevert('NotAllowed')
    r.status = 'Released'
    return this.tx('release')
  }
  async freeze(key: Hex) {
    const r = this.escrow.get(key)
    if (!r || r.status !== 'Escrowed') throw new ChainRevert('BadStatus')
    r.status = 'Frozen'
    return this.tx('freeze')
  }
  async claimRefund(key: Hex) {
    const r = this.escrow.get(key)
    if (!r || r.status !== 'Escrowed') throw new ChainRevert('BadStatus')
    if (this.clock < r.escrowedAt + this.window) throw new ChainRevert('RefundWindowOpen')
    this.refund(r)
    return this.tx('claimRefund')
  }
  private refund(r: EscrowRecord) {
    r.status = 'Refunded'
    this.refundable.set(r.refundTo.toLowerCase(), (this.refundable.get(r.refundTo.toLowerCase()) ?? 0n) + r.amount)
  }
  /** Two compliance officers, from the ops console. */
  officersUnfreeze(key: Hex) {
    const r = this.escrow.get(key)!
    if (r.status === 'Frozen') {
      r.status = 'Escrowed'
      r.escrowedAt = this.clock
    }
  }
  officersRefund(key: Hex) {
    this.refund(this.escrow.get(key)!)
  }
  async warp(seconds: number) {
    this.clock += seconds
  }
  async health() {
    return [{ chain: 'settlement', ok: true, block: this.block, relayerNative: '1.0' }]
  }
  async feeVaultBalances() {
    return [{ chain: 'base', token: 'USDC', balance: '0' }]
  }
}

export async function makeCtx(envOverrides: Partial<Config['env']> = {}) {
  const { db, close } = await openDb()
  const gw = new FakeGateway()
  const queue = new RecordingQueue()
  const ctx: Ctx = { cfg: testConfig(envOverrides), db, gw, queue, fx: mockFx, vendor: sandboxVendor, log: () => {} }
  return { ctx, gw, queue, close }
}
