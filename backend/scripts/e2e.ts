/**
 * End to end on the local chain, through the real backend and the real contracts:
 *   anvil
 *   (contracts) forge build && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 *   (backend)   npm start
 *   (backend)   npm run e2e
 * Runs the plan's demo: pay $1,000, net-settlement batch, sanctioned freeze + two-officer refund,
 * off-ramp failure → refund after the window → the sender pulls it.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { paymentEscrowAbi, reviveTypedData, sanctionsOracleAbi, type PaymentView } from '@corridor/shared'

const API = process.env.API_URL ?? 'http://127.0.0.1:4000'
const RPC = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545'
const OPS = process.env.OPS_TOKEN ?? 'dev-ops-token'
const d = JSON.parse(readFileSync(new URL('../../contracts/deployments/local.json', import.meta.url), 'utf8'))
const acct = (i: number) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: i })
const [admin, sender, receiver, officerB] = [acct(0), acct(2), acct(3), acct(4)]
const pub = createPublicClient({ chain: anvil, transport: http(RPC) })
const wallet = (a: ReturnType<typeof acct>) => createWalletClient({ chain: anvil, account: a, transport: http(RPC) })

async function api<T = any>(method: string, path: string, body?: unknown, ops = false): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(ops ? { 'x-ops-token': OPS } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`)
  return json as T
}

async function until(id: string, states: string[], timeoutMs = 90_000): Promise<PaymentView> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const p = await api<PaymentView>('GET', `/payments/${id}`)
    if (states.includes(p.state)) return p
    if (Date.now() > end) throw new Error(`payment ${id} stuck in ${p.state}: ${p.lastError}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

const check = (ok: boolean, msg: string) => {
  if (!ok) throw new Error(`FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function onboard(kind: 'businesses' | 'suppliers', body: Record<string, unknown>) {
  return api('POST', `/${kind}`, body)
}

async function payOne(businessId: string, supplierId: string, amountUsd: string, sourceChain = 'base') {
  const p = await api('POST', '/payments', { businessId, supplierId, amountUsd, invoiceRef: `INV-${Date.now()}`, sourceChain, payoutCurrency: 'INR' })
  const q = await api('POST', `/payments/${p.id}/quote`)
  const signature = await wallet(sender).signTypedData(reviveTypedData(q.typedData) as never)
  await api('POST', `/payments/${p.id}/sign`, { quoteId: q.quoteId, quoteToken: q.quoteToken, signature })
  return p.id as string
}

const officers = async (fn: 'refund' | 'unfreeze', key: Hex) => {
  for (const a of [admin, officerB]) {
    const hash = await wallet(a).writeContract({ address: d.escrow, abi: paymentEscrowAbi, functionName: fn, args: [key] })
    await pub.waitForTransactionReceipt({ hash })
  }
}

async function main() {
  console.log(`e2e against ${API} and ${RPC}`)
  const biz = await onboard('businesses', { name: 'Acme Inc', country: 'US', wallet: sender.address })
  const sup = await onboard('suppliers', { name: 'Supplier Pvt Ltd', country: 'IN', wallet: receiver.address, payoutMethod: 'wallet' })
  check(biz.kybStatus === 'verified' && sup.kybStatus === 'verified', 'business and supplier pass KYB; attestations on-chain')

  console.log('1. pay $1,000 with one signature')
  const before = await pub.readContract({ address: d.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [receiver.address] })
  const p1 = await until(await payOne(biz.id, sup.id, '1000.00'), ['COMPLETED'])
  const after = await pub.readContract({ address: d.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [receiver.address] })
  check(after - before === 1_000_000_000n, 'supplier received exactly 1,000 USDC')
  check(p1.txs.length === 3, `transactions on both chains: ${p1.txs.map((t) => t.label).join(', ')}`)

  console.log('2. net settlement: one signature, two suppliers')
  const sup2 = await onboard('suppliers', { name: 'Second Supplier', country: 'MX', wallet: acct(7).address })
  const b = await api('POST', '/batches', { businessId: biz.id, sourceChain: 'base', payoutCurrency: 'USD', legs: [{ supplierId: sup.id, amountUsd: '100.00', invoiceRef: 'B-1' }, { supplierId: sup2.id, amountUsd: '200.00', invoiceRef: 'B-2' }] })
  const sig = await wallet(sender).signTypedData(reviveTypedData(b.typedData) as never)
  await api('POST', `/batches/${b.batchId}/sign`, { quoteToken: b.quoteToken, signature: sig })
  for (const id of b.payments) await until(id, ['COMPLETED'])
  check(true, 'both batch legs paid out')

  console.log('3. sanctioned supplier: frozen in escrow, two officers refund')
  const flagged = await onboard('suppliers', { name: 'Late Listed Co', country: 'IN', wallet: acct(8).address })
  const id4 = await payOne(biz.id, flagged.id, '50.00')
  await until(id4, ['IN_TRANSIT', 'ESCROWED', 'COMPLIANCE_CLEARED', 'FROZEN', 'FUNDED_SOURCE', 'SIGNED'])
  const h = await wallet(admin).writeContract({ address: d.sanctionsOracle, abi: sanctionsOracleAbi, functionName: 'addToSanctionsList', args: [[getAddress(acct(8).address)]] })
  await pub.waitForTransactionReceipt({ hash: h })
  const frozen = await until(id4, ['FROZEN', 'COMPLETED'])
  check(frozen.state === 'FROZEN', 'payment frozen; ops case opened')
  await officers('refund', frozen.escrowKey!)
  check((await until(id4, ['REFUNDED'])).refundAvailable, 'refunded by two officers; refund waiting to be pulled')

  console.log('4. off-ramp failure: refund after the window')
  const bank = await onboard('suppliers', { name: 'Bank Payee Ltd', country: 'IN', wallet: acct(9).address, payoutMethod: 'bank', bankAccount: { bankName: 'Mock Bank', accountNumber: 'FAIL-0001', currency: 'INR' } })
  const id5 = await payOne(biz.id, bank.id, '75.00')
  await until(id5, ['PAYOUT_SENT'])
  await new Promise((r) => setTimeout(r, 5000)) // the mock bank reports the failure
  await api('POST', '/ops/dev/warp', { seconds: 72 * 3600 + 60 }, true)
  const refunded = await until(id5, ['REFUNDED'])
  check(refunded.state === 'REFUNDED', 'refunded automatically after the window')
  const w = await wallet(sender).writeContract({ address: d.escrow, abi: paymentEscrowAbi, functionName: 'withdrawRefund', args: [d.usdc as Address] })
  await pub.waitForTransactionReceipt({ hash: w })
  check(true, 'sender pulled its refunds')

  const recon = await api('POST', '/ops/reconcile', {}, true)
  check(recon.mismatches.length === 0, 'reconciliation: ledger matches the chain')
  console.log('e2e passed')
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
