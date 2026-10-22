'use client'

import type { ReactNode } from 'react'
import { HAPPY_PATH, STATE_LABELS, type PaymentState, type PaymentView } from '@corridor/shared'
import { short, usd, when } from '@/lib/format'
import { useBackendConfig } from '@/lib/hooks'
import { Notice } from './ui'

const tone = (s: PaymentState) =>
  s === 'COMPLETED'
    ? 'bg-ok-soft text-ok'
    : s === 'FROZEN'
      ? 'bg-bad-soft text-bad'
      : s === 'REFUNDED' || s === 'REFUNDING'
        ? 'bg-warn-soft text-warn'
        : 'bg-brand-soft text-brand'

export const StatusChip = ({ state, label }: { state: PaymentState; label?: string }) => (
  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone(state)}`}>{label ?? STATE_LABELS[state]}</span>
)

/** Plain-language timeline: the happy path, with the branch (hold, refund) shown where it happened. */
export function Timeline({ p }: { p: PaymentView }) {
  const branch: PaymentState[] = p.events.some((e) => e.to === 'FROZEN') ? ['FROZEN'] : []
  const refunded = p.state === 'REFUNDED' || p.state === 'REFUNDING'
  const steps: PaymentState[] = refunded
    ? [...HAPPY_PATH.filter((s) => p.events.some((e) => e.to === s)), ...branch, ...(p.state === 'REFUNDED' ? ['REFUNDED' as const] : ['REFUNDING' as const])]
    : [...HAPPY_PATH.slice(0, HAPPY_PATH.indexOf('ESCROWED') + 1), ...branch, ...HAPPY_PATH.slice(HAPPY_PATH.indexOf('ESCROWED') + 1)]
  const reached = new Set(p.events.map((e) => e.to))
  return (
    <ol className="space-y-2">
      {steps.map((s) => {
        const ev = [...p.events].reverse().find((e) => e.to === s)
        const done = reached.has(s)
        const current = p.state === s
        return (
          <li key={s} className="flex items-start gap-3">
            <span
              className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${current ? 'border-brand bg-brand' : done ? 'border-ok bg-ok' : 'border-line bg-white'}`}
            />
            <div className="min-w-0">
              <div className={`text-sm ${done ? 'font-medium' : 'text-muted'}`}>{STATE_LABELS[s]}</div>
              {ev && (
                <div className="text-xs text-muted">
                  {when(ev.at)}
                  {ev.reason ? ` · ${ev.reason}` : ''}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function TxList({ p }: { p: PaymentView }) {
  if (!p.txs.length) return <p className="text-sm text-muted">No transactions yet.</p>
  return (
    <ul className="space-y-1.5 text-sm">
      {p.txs.map((t) => (
        <li key={t.hash} className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {t.label} <span className="text-muted">· {t.chain}</span>
          </span>
          {t.url ? (
            <a href={t.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
              {short(t.hash)}
            </a>
          ) : (
            <span className="font-mono text-xs text-muted" title={t.hash}>
              {short(t.hash)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- the simple view: four steps and one sentence

/** What a person cares about. Every backend state maps onto one of these (4 = all done). */
const STAGES = ['Signed', 'Sent', 'Checked', 'Paid'] as const
const STAGE_OF: Partial<Record<PaymentState, number>> = {
  SIGNED: 0,
  FUNDED_SOURCE: 1,
  IN_TRANSIT: 1,
  ESCROWED: 2,
  COMPLIANCE_CLEARED: 2,
  FROZEN: 2,
  PAYOUT_SENT: 3,
  COMPLETED: 4,
}

function Progress({ p }: { p: PaymentView }) {
  const stage = STAGE_OF[p.state]
  if (stage === undefined) return null // not signed yet, or refunded: the sentence says it
  return (
    <ol className="grid grid-cols-4 gap-2">
      {STAGES.map((label, i) => {
        const done = i < stage
        const current = i === stage
        const bar = done ? 'bg-ok' : current ? (p.state === 'FROZEN' ? 'bg-bad' : 'animate-pulse bg-brand') : 'bg-line'
        return (
          <li key={label}>
            <div className={`h-1.5 rounded-full ${bar}`} />
            <div className={`mt-1.5 text-xs ${done || current ? 'font-medium text-ink' : 'text-muted'}`}>{label}</div>
          </li>
        )
      })}
    </ol>
  )
}

function minutesIn(p: PaymentView, state: PaymentState): number | null {
  const ev = [...p.events].reverse().find((e) => e.to === state)
  return ev ? Math.max(0, Math.floor((Date.now() - Date.parse(ev.at)) / 60_000)) : null
}

/** One plain sentence for where the payment is. */
function explain(p: PaymentView, sourceName: string, perspective: 'sender' | 'supplier'): { tone: 'info' | 'ok' | 'warn' | 'bad'; text: string } {
  const who = perspective === 'sender' ? p.supplier.name : 'You'
  switch (p.state) {
    case 'CREATED':
    case 'QUOTED':
      return p.label === 'Quote expired'
        ? { tone: 'warn', text: 'The price expired before it was signed. Nothing moved.' }
        : { tone: 'info', text: 'Waiting for a signature.' }
    case 'SIGNED':
      return { tone: 'info', text: 'Signed. Submitting the payment…' }
    case 'FUNDED_SOURCE':
      return { tone: 'info', text: `USDC taken on ${sourceName}. Sending it to Arc…` }
    case 'IN_TRANSIT': {
      const m = minutesIn(p, 'IN_TRANSIT')
      return { tone: 'info', text: `Moving to Arc through Circle. This takes about 15–20 minutes on testnet${m ? ` (${m} min so far)` : ''}.` }
    }
    case 'ESCROWED':
      return { tone: 'info', text: 'Arrived on Arc and held safely. Running compliance checks…' }
    case 'COMPLIANCE_CLEARED':
      return { tone: 'info', text: 'Checks passed. Paying out…' }
    case 'FROZEN':
      return { tone: 'bad', text: 'On hold for a compliance review. The money is safe in escrow until two officers release or refund it.' }
    case 'PAYOUT_SENT':
      return { tone: 'info', text: `Paying out${p.payoutCurrency !== 'USD' ? ' through the bank partner' : ''}…` }
    case 'COMPLETED':
      return { tone: 'ok', text: `Done. ${who} received ${receives(p)}.` }
    case 'REFUNDING':
      return { tone: 'warn', text: 'The payout failed, so this payment is being refunded.' }
    case 'REFUNDED':
      return { tone: 'warn', text: 'Refunded. The money waits on Arc for the refund address to withdraw it.' }
  }
}

const receives = (p: PaymentView) =>
  p.payoutAmount && p.payoutCurrency !== 'USD' ? `${p.payoutAmount} ${p.payoutCurrency}` : `${usd(p.net)} USDC`

/** A payment row that opens into progress, amounts, and (folded away) the technical timeline. */
export function PaymentCard({
  p,
  open,
  onToggle,
  perspective,
  children,
}: {
  p: PaymentView
  open: boolean
  onToggle: () => void
  perspective: 'sender' | 'supplier'
  children?: ReactNode
}) {
  const cfg = useBackendConfig()
  const sourceName = cfg.data?.sources.find((s) => s.key === p.sourceChain)?.name ?? p.sourceChain
  const e = explain(p, sourceName, perspective)
  return (
    <div className={`rounded-lg border bg-white transition ${open ? 'border-brand' : 'border-line hover:border-brand'}`}>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {perspective === 'sender' ? `To ${p.supplier.name}` : `From ${p.business.name}`} <span className="text-muted">· {p.invoiceRef}</span>
          </div>
          <div className="text-xs text-muted">
            {when(p.createdAt)}
            {p.batchId ? ' · batch' : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-sm font-semibold tabular-nums">${usd(p.net)}</span>
          <StatusChip state={p.state} label={p.label} />
        </div>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-3 py-4">
          <Progress p={p} />
          <Notice tone={e.tone}>{e.text}</Notice>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            {perspective === 'sender' && (
              <>
                <div>
                  <dt className="text-xs text-muted">You paid</dt>
                  <dd className="font-medium">{usd(p.amount)} USDC</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Fee</dt>
                  <dd className="font-medium">{usd(p.fee)} USDC</dd>
                </div>
              </>
            )}
            <div>
              <dt className="text-xs text-muted">{perspective === 'sender' ? 'Supplier receives' : 'You receive'}</dt>
              <dd className="font-medium">{receives(p)}</dd>
            </div>
          </dl>
          {children}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted hover:text-ink">Technical details</summary>
            <div className="mt-3 space-y-4">
              <Timeline p={p} />
              <TxList p={p} />
              <p className="font-mono text-xs break-all text-muted">payment ID {p.paymentId}</p>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
