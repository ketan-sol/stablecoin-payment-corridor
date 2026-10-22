import { keccak256, stringToHex, type Hex } from 'viem'

/**
 * KYC/KYB vendor sandbox (the plan's "vendor sandbox"): deterministic rules so the demo can show both outcomes.
 * Swap for a real vendor's sandbox API behind the same interface.
 */
export interface KybVendor {
  verify(input: { kind: 'business' | 'supplier'; name: string; country: string; wallet: string }): Promise<{
    status: 'verified' | 'rejected'
    reason: string | null
    reference: Hex // becomes the attestation UID on-chain
  }>
  /** Name screening against sanctions lists (the off-chain half of sanctions screening). */
  screenName(name: string): Promise<{ hit: boolean; list: string | null }>
}

const EMBARGOED = new Set(['KP', 'IR', 'CU', 'SY'])
const NAME_HIT = /sanction|blocked|ofac/i

export const sandboxVendor: KybVendor = {
  async verify({ kind, name, country, wallet }) {
    const reference = keccak256(stringToHex(`kyb:${kind}:${wallet.toLowerCase()}:${name}`))
    if (EMBARGOED.has(country.toUpperCase())) return { status: 'rejected', reason: `embargoed country ${country}`, reference }
    if (NAME_HIT.test(name)) return { status: 'rejected', reason: 'name matches a sanctions list', reference }
    return { status: 'verified', reason: null, reference }
  },
  async screenName(name) {
    return NAME_HIT.test(name) ? { hit: true, list: 'OFAC SDN (sandbox)' } : { hit: false, list: null }
  },
}
