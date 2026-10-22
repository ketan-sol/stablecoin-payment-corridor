import { createConnector } from '@wagmi/core'
import type { Address } from 'viem'
import { localChain } from './env'

/** Anvil's default accounts used by the local demo (contracts/script/DeployLocal.s.sol). */
export const DEMO_ACCOUNTS: { index: number; label: string; address: Address }[] = [
  { index: 2, label: 'Demo sender (#2)', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
  { index: 3, label: 'Demo supplier (#3)', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' },
  { index: 0, label: 'Officer A (#0)', address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  { index: 4, label: 'Officer B (#4)', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' },
]

/**
 * Local network only: an Anvil dev account as a wallet. Anvil keeps these accounts unlocked, so signing
 * (eth_signTypedData_v4) and sending (eth_sendTransaction) are done by the node itself. Never used on testnets.
 */
export function demoConnector(account: (typeof DEMO_ACCOUNTS)[number]) {
  const rpcUrl = localChain.rpcUrls.default.http[0]
  const KEY = 'corridor.demoAccount'
  const remember = (on: boolean) => {
    try {
      if (on) localStorage.setItem(KEY, String(account.index))
      else localStorage.removeItem(KEY)
    } catch {}
  }
  let connected = false
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === 'eth_requestAccounts') return [account.address]
      if (method === 'eth_accounts') return connected ? [account.address] : []
      if (method === 'eth_chainId') return `0x${localChain.id.toString(16)}`
      if (method === 'wallet_switchEthereumChain') return null
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? [] }),
      })
      const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } }
      if (body.error) throw Object.assign(new Error(body.error.message), body.error)
      return body.result
    },
    on() {},
    removeListener() {},
  }
  return createConnector((config) => ({
    id: `demo-${account.index}`,
    name: account.label,
    type: 'demo',
    async connect() {
      connected = true
      remember(true)
      return { accounts: [account.address], chainId: localChain.id } as never
    },
    async disconnect() {
      connected = false
      remember(false)
    },
    async getAccounts() {
      return connected ? [account.address] : []
    },
    async getChainId() {
      return localChain.id
    },
    async getProvider() {
      return provider
    },
    /** Reconnects after a reload to the demo account used last. */
    async isAuthorized() {
      try {
        return localStorage.getItem(KEY) === String(account.index)
      } catch {
        return false
      }
    },
    async switchChain() {
      return localChain
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      connected = false
      config.emitter.emit('disconnect')
    },
  }))
}
