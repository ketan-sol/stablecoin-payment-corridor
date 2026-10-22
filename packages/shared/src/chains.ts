import { defineChain } from 'viem'
import { anvil, baseSepolia, sepolia } from 'viem/chains'

/** Arc testnet: Circle's USDC-native chain; gas is paid in USDC (18 decimals natively, 6 via the ERC-20). */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } },
  testnet: true,
})

export { anvil, baseSepolia, sepolia }

/** CCTP V2 domains (Circle docs). */
export const CCTP_DOMAIN = { ethereum: 0, base: 6, arc: 26 } as const
