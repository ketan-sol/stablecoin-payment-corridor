import type { Address, Hash, Hex, Log } from 'viem'
import type { BatchIntent, PaymentIntent, Permit } from '@corridor/shared'

export const ESCROW_STATUS = ['None', 'Escrowed', 'Frozen', 'Released', 'Refunded'] as const
export type EscrowStatus = (typeof ESCROW_STATUS)[number]

export interface EscrowRecord {
  status: EscrowStatus
  token: Address
  sender: Address
  receiver: Address
  refundTo: Address
  amount: bigint
  escrowedAt: number
}

export type Receipt =
  | { status: 'pending' }
  | { status: 'success' | 'reverted'; blockNumber: number; blockHash: Hex; logs: Log[] }

export interface ChainHealth {
  chain: string
  ok: boolean
  block: number | null
  relayerNative: string | null
  error?: string
}

/** Everything the services need from chains and Circle. `viemGateway` is the real one; tests use a fake. */
export interface Gateway {
  /** "settlement" or a source key from the network config. */
  receipt(chain: string, hash: Hash): Promise<Receipt>
  blockNumber(chain: string): Promise<number>
  /** A chain's clock: the settlement chain by default (the escrow's refund window), or a source chain (permit deadlines). */
  now(chain?: string): Promise<number>
  logs(chain: string, address: Address, fromBlock: number, toBlock: number): Promise<Log[]>

  // source chains (relayer key)
  pay(source: string, intent: PaymentIntent, permit: Permit, sender: Address, signature: Hex): Promise<Hash>
  payBatch(source: string, batch: BatchIntent, permit: Permit, sender: Address, signature: Hex): Promise<Hash>

  // CCTP
  /** The CCTP message from the pay transaction's MessageSent log. */
  cctpMessage(source: string, payTx: Hash): Promise<Hex | null>
  /** Circle's attestation (Iris), or null while it is pending. Locally there is no attester. */
  attestation(source: string, payTx: Hash, message: Hex): Promise<{ message: Hex; attestation: Hex } | null>

  // settlement chain
  receivePayment(message: Hex, attestation: Hex): Promise<Hash>
  release(key: Hex, to: Address): Promise<Hash>
  freeze(key: Hex): Promise<Hash>
  claimRefund(key: Hex): Promise<Hash>
  escrowPayment(key: Hex): Promise<EscrowRecord>
  refundWindow(): Promise<number>
  totalHeld(token: Address): Promise<bigint>
  isAllowed(from: Address, to: Address): Promise<boolean>
  isVerified(account: Address): Promise<boolean>
  isSanctioned(account: Address): Promise<boolean>
  setAttestation(account: Address, uid: Hex, expiresAt: number): Promise<Hash>

  // ops
  /** Local chain only: move the clock forward (the demo's refund window). */
  warp?(seconds: number): Promise<void>
  health(): Promise<ChainHealth[]>
  feeVaultBalances(): Promise<{ chain: string; token: string; balance: string }[]>
}
