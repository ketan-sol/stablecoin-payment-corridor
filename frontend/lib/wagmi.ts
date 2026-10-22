import { createConfig, http, type Config } from 'wagmi'
import { injected } from '@wagmi/core'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { createAppKit } from '@reown/appkit/react'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { DEMO_ACCOUNTS, demoConnector } from './demoConnector'
import { CHAINS, NETWORK, REOWN_PROJECT_ID } from './env'

const transports = Object.fromEntries(CHAINS.map((c) => [c.id, http()]))

/**
 * One wallet layer for all three apps. With a Reown project ID, Reown AppKit (WalletConnect, many wallets);
 * without one (local demo), plain wagmi with the browser wallet.
 */
function build(): { config: Config; appKit: boolean } {
  if (REOWN_PROJECT_ID) {
    const networks = CHAINS as unknown as [AppKitNetwork, ...AppKitNetwork[]]
    const adapter = new WagmiAdapter({ networks, projectId: REOWN_PROJECT_ID, ssr: true, transports })
    createAppKit({
      adapters: [adapter],
      networks,
      projectId: REOWN_PROJECT_ID,
      metadata: { name: 'Corridor', description: 'Cross-border stablecoin payouts', url: 'http://localhost:3001', icons: [] },
      features: { analytics: false, email: false, socials: false },
    })
    return { config: adapter.wagmiConfig, appKit: true }
  }
  // Local network: Anvil's demo accounts too, so the demo runs without a browser wallet.
  const demo = NETWORK === 'local' ? DEMO_ACCOUNTS.map(demoConnector) : []
  return { config: createConfig({ chains: CHAINS, connectors: [injected(), ...demo], transports, ssr: true }), appKit: false }
}

export const { config: wagmiConfig, appKit: usesAppKit } = build()
