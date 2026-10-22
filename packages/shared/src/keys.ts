import { encodeAbiParameters, keccak256, type Hex } from 'viem'

/** PaymentEscrow.paymentKey: payments are keyed by source domain, because IDs are only unique per router. */
export const escrowKey = (sourceDomain: number, paymentId: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }], [sourceDomain, paymentId]))

/** PaymentEscrow.LIQUIDITY_DOMAIN: the source domain of payments a liquidity provider funds (not CCTP). */
export const LIQUIDITY_DOMAIN = 0xffffffff
