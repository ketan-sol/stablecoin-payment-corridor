/** 6-decimal base units → "1,234.56". */
export function usd(units: string | bigint | null | undefined, places = 2): string {
  if (units === null || units === undefined) return '—'
  const v = BigInt(units)
  const whole = v / 1_000_000n
  const frac = (v % 1_000_000n).toString().padStart(6, '0').slice(0, places)
  return `${whole.toLocaleString('en-US')}${places ? `.${frac}` : ''}`
}

export const short = (hex: string | null | undefined, n = 6) => (hex ? `${hex.slice(0, n + 2)}…${hex.slice(-4)}` : '—')

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
