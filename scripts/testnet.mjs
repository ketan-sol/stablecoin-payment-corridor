// Testnet setup helper (Arc testnet + Base Sepolia). Keys it makes are throwaway testnet keys: never fund them on
// mainnet. Secrets go only into gitignored files; the console shows addresses and balances.
//
//   node scripts/testnet.mjs keys     new deployer / relayer / officer B / off-ramp keys → contracts/.env
//   node scripts/testnet.mjs status   balances of those accounts on both chains
//   node scripts/testnet.mjs fund     deployer sends the relayer gas on both chains
//   node scripts/testnet.mjs sync     deployed addresses → contracts/.env, backend/.env, frontend/.env.local
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatEther, formatUnits, http, parseEther } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const root = new URL('../', import.meta.url)
const CONTRACTS_ENV = new URL('contracts/.env', root)
const BACKEND_ENV = new URL('backend/.env', root)
const FRONTEND_ENV = new URL('frontend/.env.local', root)

const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io'
const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
})
const base = { ...baseSepolia, rpcUrls: { default: { http: [BASE_RPC] } } }
const USDC = { arc: '0x3600000000000000000000000000000000000000', base: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }

// Relayer gas: a few dozen payments' worth on each chain.
const RELAYER_GAS = { arc: parseEther('3'), base: parseEther('0.005') }

function readEnv(url) {
  if (!existsSync(url)) return {}
  return Object.fromEntries(
    readFileSync(url, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

/** Sets KEY=value lines in an env file, keeping every other line (and comments) as they are. */
function upsertEnv(url, values) {
  let text = existsSync(url) ? readFileSync(url, 'utf8') : ''
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`
    const re = new RegExp(`^${k}=.*$`, 'm')
    text = re.test(text) ? text.replace(re, line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`
  }
  writeFileSync(url, text)
}

function accounts() {
  const env = readEnv(CONTRACTS_ENV)
  if (!env.DEPLOYER_KEY) throw new Error('contracts/.env has no keys yet: run `node scripts/testnet.mjs keys` first')
  return {
    env,
    deployer: privateKeyToAccount(env.DEPLOYER_KEY),
    relayer: privateKeyToAccount(env.RELAYER_KEY),
  }
}

const json = (path) => (existsSync(new URL(path, root)) ? JSON.parse(readFileSync(new URL(path, root), 'utf8')) : null)

const commands = {
  keys() {
    if (existsSync(CONTRACTS_ENV)) throw new Error('contracts/.env already exists; not overwriting its keys')
    const k = { deployer: generatePrivateKey(), relayer: generatePrivateKey(), officerB: generatePrivateKey(), offRamp: generatePrivateKey() }
    const a = Object.fromEntries(Object.entries(k).map(([n, key]) => [n, privateKeyToAccount(key).address]))
    writeFileSync(
      CONTRACTS_ENV,
      [
        '# Throwaway TESTNET keys from scripts/testnet.mjs. Never send mainnet funds to these addresses.',
        '# forge loads this file; Deploy.s.sol reads the values below.',
        `DEPLOYER_KEY=${k.deployer}`,
        `RELAYER_KEY=${k.relayer}`,
        `OFFICER_B_KEY=${k.officerB}`,
        `OFF_RAMP_KEY=${k.offRamp}`,
        `ADMIN=${a.deployer}`,
        `TREASURY=${a.deployer}`,
        `RELAYER=${a.relayer}`,
        `OFFICER_A=${a.deployer}`,
        `OFFICER_B=${a.officerB}`,
        `OFF_RAMP=${a.offRamp}`,
        '',
        '# Circle CCTP V2 (same on every testnet), Permit2, Arc USDC (developers.circle.com, docs.arc.io)',
        'TOKEN_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        'MESSAGE_TRANSMITTER=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
        'PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3',
        `USDC=${USDC.arc}`,
        'SETTLEMENT_DOMAIN=26',
        'SOURCE_DOMAIN=6',
        `ARC_RPC_URL=${ARC_RPC}`,
        `BASE_SEPOLIA_RPC_URL=${BASE_RPC}`,
        '',
        '# Filled by `node scripts/testnet.mjs sync` after each deploy step',
        '',
      ].join('\n'),
    )
    console.log('wrote contracts/.env (keys are in that file only)')
    console.table(a)
    console.log(`Fund the deployer ${a.deployer}:\n  Arc testnet USDC (gas): https://faucet.circle.com\n  Base Sepolia ETH: any Base Sepolia faucet`)
  },

  async status() {
    const { deployer, relayer } = accounts()
    const arcC = createPublicClient({ chain: arc, transport: http() })
    const baseC = createPublicClient({ chain: base, transport: http() })
    const rows = {}
    for (const [name, acc] of Object.entries({ deployer, relayer })) {
      const [arcGas, baseEth, baseUsdc] = await Promise.all([
        arcC.getBalance({ address: acc.address }),
        baseC.getBalance({ address: acc.address }),
        baseC.readContract({ address: USDC.base, abi: erc20Abi, functionName: 'balanceOf', args: [acc.address] }),
      ])
      rows[name] = { address: acc.address, 'Arc USDC (gas)': formatEther(arcGas), 'Base Sepolia ETH': formatEther(baseEth), 'Base Sepolia USDC': formatUnits(baseUsdc, 6) }
    }
    console.table(rows)
    const s = json('contracts/deployments/settlement-5042002.json')
    const src = json('contracts/deployments/source-84532.json')
    for (const [label, address, client] of [['escrow (Arc)', s?.escrow, arcC], ['router (Base Sepolia)', src?.router, baseC]]) {
      const code = address ? await client.getCode({ address }) : undefined
      console.log(`${label}: ${address ?? 'not deployed'}${address ? (code && code !== '0x' ? ' (code on chain)' : ' (NO CODE on chain yet)') : ''}`)
    }
  },

  async fund() {
    const { deployer, relayer } = accounts()
    for (const [name, chain, value] of [['Arc', arc, RELAYER_GAS.arc], ['Base Sepolia', base, RELAYER_GAS.base]]) {
      const pub = createPublicClient({ chain, transport: http() })
      if ((await pub.getBalance({ address: relayer.address })) >= value) {
        console.log(`${name}: relayer already has gas`)
        continue
      }
      const wallet = createWalletClient({ account: deployer, chain, transport: http() })
      const hash = await wallet.sendTransaction({ to: relayer.address, value })
      await pub.waitForTransactionReceipt({ hash })
      console.log(`${name}: sent ${formatEther(value)} to the relayer (${hash})`)
    }
  },

  sync() {
    const { env } = accounts()
    const s = json('contracts/deployments/settlement-5042002.json')
    const src = json('contracts/deployments/source-84532.json')
    if (!s) throw new Error('no contracts/deployments/settlement-5042002.json: deploy settlement() on Arc first')
    upsertEnv(CONTRACTS_ENV, { ESCROW: s.escrow, REGISTRY: s.registry, ...(src && { ROUTER: src.router, FEE_VAULT: src.feeVault }) })
    console.log(`contracts/.env: ESCROW, REGISTRY${src ? ', ROUTER, FEE_VAULT' : ''}`)
    if (!src) return console.log('next: deploy source() on Base Sepolia, then run sync again')

    const backend = readEnv(BACKEND_ENV)
    upsertEnv(BACKEND_ENV, {
      NETWORK: 'testnet',
      SOURCE_CHAINS: 'baseSepolia',
      RELAYER_KEY: env.RELAYER_KEY,
      // Generated once; kept on later syncs so stored Travel Rule payloads and quotes stay readable.
      TRAVEL_RULE_KEY: backend.TRAVEL_RULE_KEY ?? `0x${randomBytes(32).toString('hex')}`,
      QUOTE_SECRET: backend.QUOTE_SECRET ?? randomBytes(24).toString('hex'),
      OPS_TOKEN: backend.OPS_TOKEN ?? randomBytes(12).toString('hex'),
      PGLITE_DIR: './.data/pglite-testnet', // keep local demo data apart
      ESCROW: s.escrow,
      REGISTRY: s.registry,
      ROUTER: src.router,
      FEE_VAULT: src.feeVault,
      OFF_RAMP: env.OFF_RAMP,
      ARC_RPC_URL: env.ARC_RPC_URL,
      BASE_SEPOLIA_RPC_URL: env.BASE_SEPOLIA_RPC_URL,
    })
    upsertEnv(FRONTEND_ENV, { NEXT_PUBLIC_API_URL: 'http://localhost:4000', NEXT_PUBLIC_NETWORK: 'testnet' })
    console.log('backend/.env and frontend/.env.local set for testnet (the ops token is OPS_TOKEN in backend/.env)')
  },
}

const cmd = process.argv[2]
if (!commands[cmd]) {
  console.error(`usage: node scripts/testnet.mjs ${Object.keys(commands).join(' | ')}`)
  process.exit(1)
}
await commands[cmd]()
