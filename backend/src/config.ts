import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { CCTP_DOMAIN } from '@corridor/shared'

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const anvilKey = (i: number): Hex => {
  const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey
  return `0x${Buffer.from(key!).toString('hex')}`
}

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex)
const address = z.string().refine((a) => isAddress(a), 'invalid address').transform((a) => getAddress(a))
const num = z.coerce.number()

const Env = z.object({
  NETWORK: z.enum(['local', 'testnet']).default('local'),
  PORT: num.int().default(4000),
  DATABASE_URL: z.string().optional(), // unset: embedded Postgres (PGlite) in PGLITE_DIR
  PGLITE_DIR: z.string().default('./.data/pglite'),
  REDIS_URL: z.string().optional(), // unset: in-process queue
  RELAYER_KEY: hex32.optional(),
  OPS_TOKEN: z.string().min(8).default('dev-ops-token'),
  QUOTE_SECRET: z.string().min(16).default('dev-quote-secret-change-me'),
  TRAVEL_RULE_KEY: hex32.optional(), // AES-256-GCM key for IVMS101 payloads at rest
  QUOTE_TTL_SEC: num.int().positive().default(60),
  FEE_BPS_STANDARD: num.int().min(0).max(1000).default(30),
  FEE_BPS_PREMIUM: num.int().min(0).max(1000).default(15),
  MIN_FEE_USD: z.string().default('0.50'),
  LIMIT_PER_PAYMENT_STANDARD: z.string().default('10000'),
  LIMIT_DAILY_STANDARD: z.string().default('50000'),
  LIMIT_PER_PAYMENT_PREMIUM: z.string().default('100000'),
  LIMIT_DAILY_PREMIUM: z.string().default('500000'),
  POLL_MS: num.int().positive().default(1000),
  CONFIRMATIONS: num.int().min(0).optional(),
  IRIS_URL: z.string().default('https://iris-api-sandbox.circle.com'),
  BANK_SETTLE_MS: num.int().min(0).default(3000), // mock bank: how long a fiat transfer takes
  // local network
  LOCAL_RPC_URL: z.string().default('http://127.0.0.1:8545'),
  LOCAL_DEPLOYMENT: z.string().default('../contracts/deployments/local.json'),
  // testnet network
  SEPOLIA_RPC_URL: z.string().default('https://ethereum-sepolia-rpc.publicnode.com'),
  BASE_SEPOLIA_RPC_URL: z.string().default('https://sepolia.base.org'),
  ARC_RPC_URL: z.string().default('https://rpc.testnet.arc.io'),
  SOURCE_CHAINS: z.string().default('baseSepolia'), // testnet: the source chains a router is deployed on (comma list)
  ROUTER: address.optional(), // CREATE2 deploys: the same router and vault on every source chain
  FEE_VAULT: address.optional(),
  SEPOLIA_ROUTER: address.optional(), // per-chain addresses (e.g. Remix deploys) override ROUTER / FEE_VAULT
  SEPOLIA_FEE_VAULT: address.optional(),
  BASE_SEPOLIA_ROUTER: address.optional(),
  BASE_SEPOLIA_FEE_VAULT: address.optional(),
  ESCROW: address.optional(),
  REGISTRY: address.optional(),
  OFF_RAMP: address.optional(),
  // Post-quantum roles: escrow and registry roles held by a PQAccount on the settlement chain, signed with its
  // hash-based key; the relayer key then only pays gas. Unset: the relayer key holds the roles.
  PQ_ACCOUNT: address.optional(),
  PQ_SECRET: hex32.optional(),
  PQ_SEED: hex32.optional(),
  PQ_HEIGHT: num.int().min(1).max(20).default(10),
})

export type Env = z.infer<typeof Env>

export interface SourceNetwork {
  key: string
  name: string
  kind: 'evm'
  chainId: number
  rpcUrl: string
  domain: number // CCTP domain
  router: Address
  token: Address
  tokenSymbol: 'USDC'
  permit2: Address
  feeVault: Address
  explorer: string | null
}

export interface Network {
  kind: 'local' | 'testnet'
  settlement: {
    name: string
    chainId: number
    rpcUrl: string
    domain: number
    escrow: Address
    registry: Address
    usdc: Address
    explorer: string | null
  }
  sources: Record<string, SourceNetwork>
  offRamp: Address // the mock bank's on-chain settlement account (approved off-ramp in escrow)
}

export interface Config {
  env: Env
  network: Network
  relayerKey: Hex
  travelRuleKey: Hex
  confirmations: number
  pq: { account: Address; secret: Hex; seed: Hex; height: number } | null
}

function localNetwork(env: Env): { network: Network; offRampKey: Hex } {
  const path = resolve(process.cwd(), env.LOCAL_DEPLOYMENT)
  const d = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | number>
  const a = (k: string) => getAddress(String(d[k]))
  const chainId = Number(d.chainId)
  const common = { chainId, rpcUrl: env.LOCAL_RPC_URL, feeVault: a('feeVault'), explorer: null }
  return {
    offRampKey: anvilKey(6),
    network: {
      kind: 'local',
      settlement: {
        name: 'Arc (local)',
        chainId,
        rpcUrl: env.LOCAL_RPC_URL,
        domain: Number(d.settlementDomain),
        escrow: a('escrow'),
        registry: a('registry'),
        usdc: a('usdc'),
        explorer: null,
      },
      sources: {
        base: {
          ...common,
          key: 'base',
          name: 'Base (local)',
          kind: 'evm',
          domain: Number(d.sourceDomain),
          router: a('router'),
          token: a('usdc'),
          tokenSymbol: 'USDC',
          permit2: a('permit2'),
        },
      },
      offRamp: a('offRamp'),
    },
  }
}

function testnetNetwork(env: Env): Network {
  const need = <T>(v: T | undefined, name: string): T => {
    if (v === undefined) throw new Error(`NETWORK=testnet needs ${name}`)
    return v
  }
  const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  // Router and fee vault per chain, falling back to the shared CREATE2 addresses.
  const deployed = (prefix: 'SEPOLIA' | 'BASE_SEPOLIA') => ({
    router: need(env[`${prefix}_ROUTER`] ?? env.ROUTER, `${prefix}_ROUTER (or ROUTER)`),
    feeVault: need(env[`${prefix}_FEE_VAULT`] ?? env.FEE_VAULT, `${prefix}_FEE_VAULT (or FEE_VAULT)`),
  })
  const all: Record<string, () => SourceNetwork> = {
    sepolia: () => ({
      key: 'sepolia',
      name: 'Ethereum Sepolia',
      kind: 'evm',
      chainId: 11155111,
      rpcUrl: env.SEPOLIA_RPC_URL,
      domain: CCTP_DOMAIN.ethereum,
      ...deployed('SEPOLIA'),
      token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      tokenSymbol: 'USDC',
      permit2: PERMIT2,
      explorer: 'https://sepolia.etherscan.io',
    }),
    baseSepolia: () => ({
      key: 'baseSepolia',
      name: 'Base Sepolia',
      kind: 'evm',
      chainId: 84532,
      rpcUrl: env.BASE_SEPOLIA_RPC_URL,
      domain: CCTP_DOMAIN.base,
      ...deployed('BASE_SEPOLIA'),
      token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenSymbol: 'USDC',
      permit2: PERMIT2,
      explorer: 'https://sepolia.basescan.org',
    }),
  }
  // Only the enabled chains need addresses.
  const sources = Object.fromEntries(
    env.SOURCE_CHAINS.split(',').map((k) => {
      const key = k.trim()
      if (!all[key]) throw new Error(`SOURCE_CHAINS: unknown chain ${key}; use ${Object.keys(all).join(', ')}`)
      return [key, all[key]()]
    }),
  )
  return {
    kind: 'testnet',
    settlement: {
      name: 'Arc Testnet',
      chainId: 5042002,
      rpcUrl: env.ARC_RPC_URL,
      domain: CCTP_DOMAIN.arc,
      escrow: need(env.ESCROW, 'ESCROW'),
      registry: need(env.REGISTRY, 'REGISTRY'),
      usdc: '0x3600000000000000000000000000000000000000',
      explorer: 'https://explorer.testnet.arc.io',
    },
    sources,
    offRamp: need(env.OFF_RAMP, 'OFF_RAMP'),
  }
}

export function loadConfig(raw: Record<string, string | undefined> = process.env): Config {
  const env = Env.parse(raw)
  const local = env.NETWORK === 'local'
  if (!local && (!env.RELAYER_KEY || !env.TRAVEL_RULE_KEY)) {
    throw new Error('NETWORK=testnet needs RELAYER_KEY and TRAVEL_RULE_KEY')
  }
  if (env.PQ_ACCOUNT && (!env.PQ_SECRET || !env.PQ_SEED)) throw new Error('PQ_ACCOUNT needs PQ_SECRET and PQ_SEED')
  const network = local ? localNetwork(env).network : testnetNetwork(env)
  return {
    env,
    network,
    // Local default is Anvil's well-known relayer account (see DeployLocal.s.sol).
    relayerKey: env.RELAYER_KEY ?? anvilKey(1),
    travelRuleKey: env.TRAVEL_RULE_KEY ?? `0x${'11'.repeat(32)}`,
    confirmations: env.CONFIRMATIONS ?? (local ? 0 : 1),
    pq: env.PQ_ACCOUNT ? { account: env.PQ_ACCOUNT, secret: env.PQ_SECRET!, seed: env.PQ_SEED!, height: env.PQ_HEIGHT } : null,
  }
}

/** Anvil account keys for local tooling (e2e script, mock bank). */
export const localKeys = { relayer: anvilKey(1), sender: anvilKey(2), offRamp: anvilKey(6) }
