import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getAddress, type Address, type Hex } from 'viem'
import type { CounterpartyView } from '@corridor/shared'
import type { Ctx } from '../ctx'
import { counterparties } from '../db/schema'
import { HttpError } from '../errors'

type Counterparty = typeof counterparties.$inferSelect

export interface OnboardInput {
  kind: 'business' | 'supplier'
  name: string
  country: string
  wallet: string
  tier?: 'standard' | 'premium'
  payoutMethod?: 'wallet' | 'bank'
  bankAccount?: { bankName: string; accountNumber: string; currency: string } | null
  webhookUrl?: string | null
}

const KYB_VALID_DAYS = 365

export function counterpartyView(c: Counterparty): CounterpartyView {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    country: c.country,
    wallet: c.wallet as Address,
    kybStatus: c.kybStatus,
    kybExpiresAt: c.kybExpiresAt?.toISOString() ?? null,
    tier: c.tier,
    payoutMethod: c.payoutMethod,
    bankAccount: c.bankAccount ?? null,
  }
}

/**
 * Onboarding: the vendor sandbox runs KYB once; a pass is written on-chain as an attestation (UID = the vendor's
 * reference, one-year expiry) that the escrow's compliance check reads. Re-onboarding the same wallet updates it.
 */
export async function onboard(ctx: Ctx, input: OnboardInput): Promise<Counterparty & { attestationTx?: Hex }> {
  const wallet = getAddress(input.wallet)
  if (input.kind === 'supplier' && input.payoutMethod === 'bank' && !input.bankAccount) {
    throw new HttpError(400, 'bank payouts need bank account details')
  }
  const result = await ctx.vendor.verify({ kind: input.kind, name: input.name, country: input.country, wallet })
  const expiresAt = new Date(Date.now() + KYB_VALID_DAYS * 86_400_000)

  const values = {
    kind: input.kind,
    name: input.name,
    country: input.country.toUpperCase(),
    wallet,
    tier: input.tier ?? 'standard',
    payoutMethod: input.payoutMethod ?? 'wallet',
    bankAccount: input.bankAccount ?? null,
    webhookUrl: input.webhookUrl ?? null,
    kybStatus: result.status === 'verified' ? ('pending' as const) : ('rejected' as const),
    kybUid: result.reference,
    kybReason: result.reason,
    kybExpiresAt: null,
  }
  const [existing] = await ctx.db
    .select()
    .from(counterparties)
    .where(and(eq(counterparties.kind, input.kind), eq(counterparties.wallet, wallet)))
  const [row] = existing
    ? await ctx.db.update(counterparties).set(values).where(eq(counterparties.id, existing.id)).returning()
    : await ctx.db
        .insert(counterparties)
        .values({ ...values, webhookSecret: randomBytes(24).toString('hex') })
        .returning()

  if (result.status !== 'verified') return row
  // Write the attestation; the record turns "verified" once it is on-chain.
  const attestationTx = await ctx.gw.setAttestation(wallet, result.reference, Math.floor(expiresAt.getTime() / 1000))
  const receipt = await waitForReceipt(ctx, 'settlement', attestationTx)
  if (receipt !== 'success') throw new HttpError(502, 'the KYB attestation transaction failed')
  const [verified] = await ctx.db
    .update(counterparties)
    .set({ kybStatus: 'verified', kybExpiresAt: expiresAt })
    .where(eq(counterparties.id, row.id))
    .returning()
  return { ...verified, attestationTx }
}

export async function waitForReceipt(ctx: Ctx, chain: string, hash: Hex, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await ctx.gw.receipt(chain, hash)
    if (r.status !== 'pending') return r.status
    if (Date.now() > until) return 'pending'
    await new Promise((res) => setTimeout(res, 250))
  }
}

export async function getCounterparty(ctx: Ctx, id: string, kind?: 'business' | 'supplier') {
  const [c] = await ctx.db.select().from(counterparties).where(eq(counterparties.id, id))
  if (!c || (kind && c.kind !== kind)) throw new HttpError(404, `${kind ?? 'counterparty'} not found`)
  return c
}
