import { keccak256, stringToHex, type Hex } from 'viem'

/** IVMS101-style originator / beneficiary data (the subset this demo fills in). */
export interface TravelRulePayload {
  originator: { name: string; accountNumber: string; country: string; lei?: string }
  beneficiary: { name: string; accountNumber: string; country: string }
  invoiceRef: string
  amount: { value: string; currency: string }
}

/** Sorted keys, no whitespace, UTF-8: anyone holding the payload re-derives the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The value the sender signs into the intent. The payload itself stays off-chain, encrypted. */
export const travelRuleHash = (payload: TravelRulePayload): Hex => keccak256(stringToHex(canonicalJson(payload)))
