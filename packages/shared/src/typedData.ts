import type { Address, Hex } from 'viem'

/** Canonical Permit2 (same on Sepolia, Base Sepolia and Arc; the local chain deploys its own). */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export interface PaymentIntent {
  paymentId: Hex
  receiver: Address
  refundTo: Address
  fee: bigint
  destinationDomain: number
  travelRuleHash: Hex
}

export interface Leg {
  paymentId: Hex
  receiver: Address
  amount: bigint
  travelRuleHash: Hex
}

export interface BatchIntent {
  legs: Leg[]
  refundTo: Address
  fee: bigint
  destinationDomain: number
}

export interface Permit {
  permitted: { token: Address; amount: bigint }
  nonce: bigint
  deadline: bigint
}


const TokenPermissions = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const

const PaymentIntentType = [
  { name: 'paymentId', type: 'bytes32' },
  { name: 'receiver', type: 'address' },
  { name: 'refundTo', type: 'address' },
  { name: 'fee', type: 'uint256' },
  { name: 'destinationDomain', type: 'uint32' },
  { name: 'travelRuleHash', type: 'bytes32' },
] as const

const LegType = [
  { name: 'paymentId', type: 'bytes32' },
  { name: 'receiver', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'travelRuleHash', type: 'bytes32' },
] as const

const BatchIntentType = [
  { name: 'legs', type: 'Leg[]' },
  { name: 'refundTo', type: 'address' },
  { name: 'fee', type: 'uint256' },
  { name: 'destinationDomain', type: 'uint32' },
] as const

const witnessFields = <W extends string>(witnessType: W) =>
  [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: witnessType },
  ] as const

interface Domain {
  chainId: number
  permit2: Address
  router: Address
}

/** Permit2 PermitWitnessTransferFrom with the router's PaymentIntent witness (`PaymentRouter.pay`). */
export function paymentTypedData({ chainId, permit2, router }: Domain, permit: Permit, intent: PaymentIntent) {
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: permit2 },
    types: {
      PermitWitnessTransferFrom: witnessFields('PaymentIntent'),
      TokenPermissions,
      PaymentIntent: PaymentIntentType,
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: { ...permit, spender: router, witness: intent },
  } as const
}

/** Same, with the BatchIntent witness (`PaymentRouter.payBatch`, net settlement). */
export function batchTypedData({ chainId, permit2, router }: Domain, permit: Permit, batch: BatchIntent) {
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: permit2 },
    types: {
      PermitWitnessTransferFrom: witnessFields('BatchIntent'),
      TokenPermissions,
      BatchIntent: BatchIntentType,
      Leg: LegType,
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: { ...permit, spender: router, witness: batch },
  } as const
}

/** JSON-safe copy (bigints as decimal strings), the shape wallets accept in eth_signTypedData_v4. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

type Field = { name: string; type: string }

/**
 * Inverse of `toJsonSafe` for typed data: turns the decimal-string integers from the API back into bigints, guided by
 * the `types` table, so viem/wagmi `signTypedData` accepts it.
 */
export function reviveTypedData<T extends { types: Record<string, readonly Field[]>; primaryType: string; message: unknown }>(td: T): T {
  const revive = (type: string, value: unknown): unknown => {
    if (type.endsWith('[]')) return (value as unknown[]).map((v) => revive(type.slice(0, -2), v))
    if (/^u?int\d*$/.test(type)) return typeof value === 'string' ? BigInt(value) : value
    const fields = td.types[type]
    if (!fields) return value
    const o = value as Record<string, unknown>
    return Object.fromEntries(fields.map((f) => [f.name, revive(f.type, o[f.name])]))
  }
  const message = revive(td.primaryType, td.message) as Record<string, unknown>
  // uint32 fields stay numbers for wallets; viem accepts number or bigint for them.
  return { ...td, message }
}
