/** USDC amounts: 6 decimals everywhere, carried as bigint base units. */
const SCALE = 1_000_000n

/** "1000.5" → 1000500000n. Rejects anything that is not a plain positive decimal with ≤ 6 places. */
export function parseUnits6(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`invalid amount: ${value}`)
  const [whole, frac = ''] = value.split('.')
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(6, '0'))
}

export function formatUnits6(value: bigint, places = 2): string {
  const neg = value < 0n
  const v = neg ? -value : value
  const whole = v / SCALE
  const frac = (v % SCALE).toString().padStart(6, '0').slice(0, places)
  return `${neg ? '-' : ''}${whole}${places ? `.${frac}` : ''}`
}

/** amount × bps / 10_000, rounded down (never over-charge). */
export const bps = (amount: bigint, basisPoints: number) => (amount * BigInt(basisPoints)) / 10_000n

/** amount (6 decimals) × a decimal rate string, to `places` decimals of the target currency. */
export function convert(amount: bigint, rate: string, places = 2): string {
  const [w, f = ''] = rate.split('.')
  const rateScaled = BigInt(w + f.padEnd(8, '0').slice(0, 8)) // rate × 1e8
  const out = (amount * rateScaled) / 100_000_000n // still 6 decimals
  return formatUnits6(out, places)
}
