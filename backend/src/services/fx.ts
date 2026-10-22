/**
 * FX and peg. The plan: Chainlink where available, otherwise a mocked FX API. Testnets have no reliable FX feeds,
 * so this is the mock: fixed mid rates with a deterministic per-minute wobble, so quotes visibly move.
 */
const MID: Record<string, number> = { USD: 1, INR: 83.2, EUR: 0.92, GBP: 0.79, MXN: 17.1, PHP: 56.5, BRL: 5.1 }

export const PAYOUT_CURRENCIES = Object.keys(MID)

export interface FxSource {
  rate(currency: string, at?: Date): Promise<string>
  /** USDC/USD; quotes stop if it drifts more than the tolerance (depeg risk). */
  usdcUsd(): Promise<number>
}

export const mockFx: FxSource = {
  async rate(currency, at = new Date()) {
    const mid = MID[currency]
    if (mid === undefined) throw new Error(`unsupported payout currency ${currency}`)
    if (currency === 'USD') return '1.00000000'
    const minute = Math.floor(at.getTime() / 60_000)
    const wobble = 1 + (((minute * 2654435761) % 1000) / 1000 - 0.5) * 0.002 // ±0.1%
    return (mid * wobble).toFixed(8)
  },
  async usdcUsd() {
    return 1.0
  },
}

export const DEPEG_TOLERANCE = 0.005
