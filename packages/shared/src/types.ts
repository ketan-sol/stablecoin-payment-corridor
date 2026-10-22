import type { Address, Hex } from 'viem'
import type { PaymentState } from './states'

/** What the backend's GET /config returns: everything a client needs to talk to the chains. */
export interface SourceChainConfig {
  key: string
  name: string
  kind: 'evm'
  chainId: number
  rpcUrl: string
  domain: number
  router: Address
  token: Address // USDC
  tokenSymbol: 'USDC'
  permit2: Address
  feeVault: Address
  explorer: string | null
}

export interface PublicConfig {
  network: 'local' | 'testnet'
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
  sources: SourceChainConfig[]
  payoutCurrencies: string[]
  quoteTtlSec: number
}

export interface CounterpartyView {
  id: string
  kind: 'business' | 'supplier'
  name: string
  country: string
  wallet: Address
  kybStatus: 'pending' | 'verified' | 'rejected'
  kybExpiresAt: string | null
  tier: 'standard' | 'premium'
  payoutMethod: 'wallet' | 'bank'
  bankAccount: { bankName: string; accountNumber: string; currency: string } | null
}

export interface TxLink {
  label: string
  chain: string
  hash: Hex
  url: string | null
}

export interface PaymentEventView {
  at: string
  from: PaymentState | null
  to: PaymentState
  label: string
  actor: string
  reason: string | null
}

export interface PaymentView {
  id: string
  paymentId: Hex
  batchId: string | null
  state: PaymentState
  label: string
  business: { id: string; name: string }
  supplier: { id: string; name: string }
  sourceChain: string
  amountUsd: string
  amount: string // token base units (6 decimals)
  fee: string
  net: string
  payoutCurrency: string
  payoutAmount: string | null
  invoiceRef: string
  refundTo: Address
  escrowKey: Hex | null
  refundAvailable: boolean
  lastError: string | null
  txs: TxLink[]
  events: PaymentEventView[]
  createdAt: string
  updatedAt: string
}

export interface QuoteView {
  quoteId: string
  quoteToken: string // HMAC over the quote; sent back with the signature
  expiresAt: string
  amount: string
  fee: string
  net: string
  fxRate: string
  payoutCurrency: string
  payoutAmount: string
  /** EIP-712 / TIP-712 payload for the wallet, uint256 fields as decimal strings. */
  typedData: unknown
}
