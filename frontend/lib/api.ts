import type { CounterpartyView, PaymentView, PublicConfig, QuoteView } from '@corridor/shared'
import { API_URL } from './env'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export async function api<T>(method: string, path: string, body?: unknown, opsToken?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opsToken ? { 'x-ops-token': opsToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const type = res.headers.get('content-type') ?? ''
  const data = type.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, (data as { code?: string }).code)
  return data as T
}

export const backend = {
  config: () => api<PublicConfig>('GET', '/config'),
  businessByWallet: (wallet: string) => api<CounterpartyView[]>('GET', `/businesses?wallet=${wallet}`).then((r) => r[0] ?? null),
  supplierByWallet: (wallet: string) => api<CounterpartyView[]>('GET', `/suppliers?wallet=${wallet}`).then((r) => r[0] ?? null),
  suppliers: () => api<CounterpartyView[]>('GET', '/suppliers'),
  onboard: (kind: 'businesses' | 'suppliers', body: Record<string, unknown>) =>
    api<CounterpartyView & { kybReason?: string | null }>('POST', `/${kind}`, body),
  setPayoutMethod: (id: string, body: Record<string, unknown>) => api<CounterpartyView>('PATCH', `/suppliers/${id}/payout-method`, body),
  createPayment: (body: Record<string, unknown>) => api<PaymentView>('POST', '/payments', body),
  quote: (id: string) => api<QuoteView>('POST', `/payments/${id}/quote`),
  sign: (id: string, body: { quoteId: string; quoteToken: string; signature: string }) => api<PaymentView>('POST', `/payments/${id}/sign`, body),
  createBatch: (body: Record<string, unknown>) =>
    api<{ batchId: string; quoteToken: string; expiresAt: string; amount: string; fee: string; net: string; fxRate: string; payments: string[]; typedData: unknown }>(
      'POST',
      '/batches',
      body,
    ),
  signBatch: (id: string, body: { quoteToken: string; signature: string }) => api('POST', `/batches/${id}/sign`, body),
  payments: (q: string) => api<PaymentView[]>('GET', `/payments?${q}`),
  payment: (id: string) => api<PaymentView>('GET', `/payments/${id}`),
  receipt: (id: string) => api<Record<string, unknown>>('GET', `/payments/${id}/receipt`),
  pacs008Url: (id: string) => `${API_URL}/payments/${id}/pacs008`,
}
