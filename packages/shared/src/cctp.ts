import { decodeAbiParameters, hexToBigInt, hexToNumber, slice, type Address, type Hex } from 'viem'

/** CCTP V2 MessageV2 header + BurnMessageV2 body byte offsets (Circle's MessageV2.sol / BurnMessageV2.sol). */
const BODY = 148

export interface ParsedMessage {
  sourceDomain: number
  destinationDomain: number
  nonce: Hex
  destinationCaller: Address
  mintRecipient: Address
  amount: bigint
  messageSender: Address
  feeExecuted: bigint
  hook: { sender: Address; refundTo: Address; legs: { paymentId: Hex; receiver: Address; amount: bigint; travelRuleHash: Hex }[] } | null
}

const addr = (word: Hex) => slice(word, 12) as Address

export function parseCctpMessage(message: Hex): ParsedMessage {
  const body = slice(message, BODY)
  const hookData = slice(body, 228)
  let hook: ParsedMessage['hook'] = null
  if ((hookData.length - 2) / 2 >= 96) {
    try {
      const [sender, refundTo, legs] = decodeAbiParameters(
        [
          { type: 'address' },
          { type: 'address' },
          {
            type: 'tuple[]',
            components: [
              { name: 'paymentId', type: 'bytes32' },
              { name: 'receiver', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'travelRuleHash', type: 'bytes32' },
            ],
          },
        ],
        hookData,
      )
      hook = { sender, refundTo, legs: [...legs] }
    } catch {
      hook = null
    }
  }
  return {
    sourceDomain: hexToNumber(slice(message, 4, 8)),
    destinationDomain: hexToNumber(slice(message, 8, 12)),
    nonce: slice(message, 12, 44),
    destinationCaller: addr(slice(message, 108, 140)),
    mintRecipient: addr(slice(body, 36, 68)),
    amount: hexToBigInt(slice(body, 68, 100)),
    messageSender: addr(slice(body, 100, 132)),
    feeExecuted: hexToBigInt(slice(body, 164, 196)),
    hook,
  }
}
