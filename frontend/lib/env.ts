import { defineChain, type Chain } from 'viem'
import { arcTestnet, baseSepolia, sepolia } from '@corridor/shared'

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'local') as 'local' | 'testnet'
export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? ''

/** The local Anvil chain plays Base and Arc at once (see contracts/script/DeployLocal.s.sol). */
export const localChain = defineChain({
  id: 31337,
  name: 'Corridor local (Anvil)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545'] } },
  testnet: true,
})

/** A chain with the RPC the app (and a wallet adding the chain) should use. */
const withRpc = (chain: Chain, url: string | undefined): Chain =>
  url ? { ...chain, rpcUrls: { default: { http: [url] } } } : chain

// NEXT_PUBLIC_* values are inlined at build time, so each is read by its full name.
export const CHAINS: [Chain, ...Chain[]] =
  NETWORK === 'local'
    ? [localChain]
    : [
        withRpc(sepolia, process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'),
        withRpc(baseSepolia, process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
        withRpc(arcTestnet, process.env.NEXT_PUBLIC_ARC_RPC_URL),
      ]
