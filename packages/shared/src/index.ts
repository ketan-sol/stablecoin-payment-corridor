export * from './abi'
export * from './cctp'
export * from './keys'
export * from './chains'
export * from './states'
export * from './travelRule'
export * from './typedData'
export * from './types'

/** USDC uses 6 decimals everywhere; no 18-decimal assumptions in fee or FX math. */
export const TOKEN_DECIMALS = 6
