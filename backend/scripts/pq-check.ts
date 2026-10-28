/**
 * Local check that the backend's settlement roles work through a PQAccount, on a real chain.
 * Run Anvil and DeployLocal first (README "Run it locally"), then from backend/: npx tsx scripts/pq-check.ts
 * Moves the registry's COMPLIANCE_OFFICER and the escrow's FREEZER from the relayer key to a fresh PQAccount, checks
 * both, then gives the roles back.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { complianceRegistryAbi, paymentEscrowAbi } from '@corridor/shared'
import { viemGateway } from '../src/chain/viemGateway'
import { loadConfig } from '../src/config'
import { errorMessage } from '../src/errors'
import { PQSigner } from '../src/pq'

const ADMIN = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') // Anvil #0: DeployLocal's admin
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}

const base = loadConfig({ NETWORK: 'local' })
const pub = createPublicClient({ chain: foundry, transport: http(base.env.LOCAL_RPC_URL) })
const admin = createWalletClient({ chain: foundry, account: ADMIN, transport: http(base.env.LOCAL_RPC_URL) })
const wait = async (hash: Hex) => pub.waitForTransactionReceipt({ hash })

const secret = keccak256(stringToHex('pq-check secret'))
const seed = keccak256(stringToHex('pq-check seed'))
const height = 4
const signer = new PQSigner(secret, seed, height)
const art = JSON.parse(readFileSync('../contracts/out/PQAccount.sol/PQAccount.json', 'utf8'))
const account = (await wait(await admin.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [signer.root, seed, BigInt(height)] })))
  .contractAddress as Address
console.log('PQAccount', account)

const { registry, escrow } = base.network.settlement
const relayer = privateKeyToAccount(base.relayerKey).address
const officer = await pub.readContract({ address: registry, abi: complianceRegistryAbi, functionName: 'COMPLIANCE_OFFICER' })
const freezer = await pub.readContract({ address: escrow, abi: paymentEscrowAbi, functionName: 'FREEZER' })
const roles = [
  { address: registry, abi: complianceRegistryAbi, role: officer },
  { address: escrow, abi: paymentEscrowAbi, role: freezer },
] as const
const move = async (from: Address, to: Address) => {
  for (const r of roles) {
    await wait(await admin.writeContract({ address: r.address, abi: r.abi as never, functionName: 'grantRole' as never, args: [r.role, to] as never }))
    await wait(await admin.writeContract({ address: r.address, abi: r.abi as never, functionName: 'revokeRole' as never, args: [r.role, from] as never }))
  }
}
await move(relayer, account)

try {
  let next = 0
  const viaPq = viemGateway({ ...base, pq: { account, secret, seed, height } }, async () => next++)
  const plain = viemGateway(base)
  const who = privateKeyToAccount(generatePrivateKey()).address
  const expires = Number((await pub.getBlock()).timestamp) + 86400

  const refused = await plain.setAttestation(who, keccak256('0x01'), expires).then(() => null, errorMessage)
  check(refused !== null, `relayer ECDSA key alone is refused: ${refused}`)

  const r = await wait(await viaPq.setAttestation(who, keccak256('0x01'), expires))
  check(r.status === 'success' && r.to?.toLowerCase() === account.toLowerCase(), `setAttestation through PQAccount.execute (gas ${r.gasUsed})`)
  check(await viaPq.isVerified(who), 'registry now has the attestation')
  check(await pub.readContract({ address: account, abi: art.abi, functionName: 'spent', args: [signer.root, 0n] }) === true, 'leaf 0 burnt on-chain')

  const inner = await viaPq.freeze(keccak256('0xdead')).then(() => null, errorMessage)
  check(inner !== null && inner.includes('BadStatus'), `escrow's own error decoded through execute: ${inner}`)
  check(next === 2, 'each send reserved a fresh leaf (2 used)')
} finally {
  await move(account, relayer)
  console.log('roles returned to the relayer')
}
console.log('PQ_CHECK_PASSED')
