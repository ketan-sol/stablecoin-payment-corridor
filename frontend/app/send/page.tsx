'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { maxUint256, zeroAddress, type Address } from 'viem'
import { useAccount, useReadContract, useSignTypedData, useWriteContract } from 'wagmi'
import { erc20Abi, paymentEscrowAbi, reviveTypedData, type CounterpartyView, type PaymentView, type QuoteView, type SourceChainConfig } from '@corridor/shared'
import { PaymentCard } from '@/components/payment'
import { Button, Card, Empty, Field, Input, Notice, Select } from '@/components/ui'
import { ConnectFirst } from '@/components/wallet'
import { ApiError, backend } from '@/lib/api'
import { usd } from '@/lib/format'
import { useBackendConfig, useEnsureChain } from '@/lib/hooks'

const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message)

const COUNTRIES_REJECTED = 'Names containing "sanction", "blocked" or "ofac", and the countries KP, IR, CU and SY, fail the sandbox check on purpose.'

/** Pay a supplier: verify the business, allow USDC once, then each payment is one signature. */
export default function PayPage() {
  const { address } = useAccount()
  const cfg = useBackendConfig()
  const business = useQuery({ queryKey: ['business', address], queryFn: () => backend.businessByWallet(address!), enabled: !!address })
  const [sourceKey, setSourceKey] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const source = cfg.data?.sources.find((s) => s.key === sourceKey) ?? cfg.data?.sources[0]
  const owner = address ?? zeroAddress
  const read = { address: source?.token, abi: erc20Abi, chainId: source?.chainId } as const
  const allowance = useReadContract({ ...read, functionName: 'allowance', args: [owner, source?.permit2 ?? zeroAddress], query: { enabled: !!address && !!source } })
  const balance = useReadContract({ ...read, functionName: 'balanceOf', args: [owner], query: { enabled: !!address && !!source, refetchInterval: 5000 } })

  if (!address) return <ConnectFirst what="pay a supplier" />
  if (business.isLoading || !cfg.data || !source) return <p className="text-sm text-muted">Loading…</p>

  const b = business.data
  const verified = b?.kybStatus === 'verified'
  // Approved for good (max), or at least for everything in the wallet.
  const approved = allowance.data !== undefined && (allowance.data >= 10n ** 30n || (balance.data !== undefined && balance.data > 0n && allowance.data >= balance.data))

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold">Pay a supplier</h1>
        <p className="text-sm text-muted">
          {b ? `${b.name} · ` : ''}USDC on {source.name} → paid out on Arc
        </p>
      </div>

      <Step n={1} title="Verify your business" done={verified} summary={b?.name}>
        {b && !verified ? (
          <Notice tone="bad">
            Verification failed for {b.name}. {COUNTRIES_REJECTED}
          </Notice>
        ) : (
          <BusinessForm wallet={address} onDone={() => business.refetch()} />
        )}
      </Step>

      <Step n={2} title="Allow USDC payments" done={approved} locked={!verified} summary={balance.data !== undefined ? `Balance ${usd(balance.data)} USDC` : undefined}>
        <Approve source={source} onDone={() => setTimeout(() => allowance.refetch(), 1500)} />
      </Step>

      <Step n={3} title="Send a payment" done={false} locked={!verified || !approved}>
        {b && <PayForm business={b} source={source} balance={balance.data} onPaid={setOpen} sources={cfg.data.sources} onSource={setSourceKey} />}
      </Step>

      {b && <Payments businessId={b.id} open={open} setOpen={setOpen} />}
    </div>
  )
}

function Step({ n, title, done, locked, summary, children }: { n: number; title: string; done: boolean; locked?: boolean; summary?: ReactNode; children?: ReactNode }) {
  return (
    <section className={`rounded-xl border bg-white p-5 shadow-sm ${done || locked ? 'border-line' : 'border-brand'}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? 'bg-ok-soft text-ok' : locked ? 'bg-slate-100 text-muted' : 'bg-brand text-white'}`}
        >
          {done ? '✓' : n}
        </span>
        <h2 className={`font-semibold ${locked ? 'text-muted' : ''}`}>{title}</h2>
        {done && summary && <span className="ml-auto truncate text-sm text-muted">{summary}</span>}
      </div>
      {!done && !locked && children && <div className="mt-4">{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------- step 1

function BusinessForm({ wallet, onDone }: { wallet: Address; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', country: 'US' })
  const m = useMutation({ mutationFn: () => backend.onboard('businesses', { ...form, wallet }), onSuccess: onDone })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Company name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Inc" />
        </Field>
        <Field label="Country code">
          <Input value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} />
        </Field>
      </div>
      <p className="text-xs text-muted">A quick sandbox KYB check. When it passes, your wallet is marked verified on Arc.</p>
      {m.error && <Notice tone="bad">{errorText(m.error)}</Notice>}
      <Button type="submit" busy={m.isPending} disabled={form.name.length < 2 || form.country.length !== 2}>
        Verify
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------- step 2

function Approve({ source, onDone }: { source: SourceChainConfig; onDone: () => void }) {
  const ensure = useEnsureChain()
  const { writeContractAsync, isPending, error } = useWriteContract()
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        One transaction on {source.name} lets every later payment be a single signature, with no gas for you. (It approves Permit2, the
        standard Uniswap signature contract.)
      </p>
      {error && <Notice tone="bad">{errorText(error)}</Notice>}
      <Button
        busy={isPending}
        onClick={async () => {
          await ensure(source.chainId)
          await writeContractAsync({ address: source.token, abi: erc20Abi, functionName: 'approve', args: [source.permit2, maxUint256], chainId: source.chainId })
          onDone()
        }}
      >
        Allow USDC
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- step 3

interface Extra {
  supplierId: string
  amountUsd: string
}

type Quote = { kind: 'single'; paymentId: string; q: QuoteView } | { kind: 'batch'; b: Awaited<ReturnType<typeof backend.createBatch>> }

const AMOUNT = /^\d+(\.\d{1,2})?$/
const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '')
const newRef = () => `INV-${today()}-${Math.floor(Math.random() * 9000 + 1000)}`

function PayForm({
  business,
  source,
  sources,
  balance,
  onSource,
  onPaid,
}: {
  business: CounterpartyView
  source: SourceChainConfig
  sources: SourceChainConfig[]
  balance: bigint | undefined
  onSource: (key: string) => void
  onPaid: (id: string) => void
}) {
  const cfg = useBackendConfig()
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: backend.suppliers })
  const verified = useMemo(() => (suppliers.data ?? []).filter((s) => s.kybStatus === 'verified'), [suppliers.data])
  const [supplierId, setSupplierId] = useState('')
  const [adding, setAdding] = useState(false)
  const [amount, setAmount] = useState('10.00')
  const [currency, setCurrency] = useState('INR')
  const [invoiceRef, setInvoiceRef] = useState(newRef)
  const [extra, setExtra] = useState<Extra[] | null>(null) // several suppliers in one signature
  const [quote, setQuote] = useState<Quote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'quote' | 'sign' | null>(null)
  const ensure = useEnsureChain()
  const { signTypedDataAsync } = useSignTypedData()
  const qc = useQueryClient()

  useEffect(() => {
    if (!supplierId && verified[0]) setSupplierId(verified[0].id)
  }, [verified, supplierId])

  const supplier = verified.find((s) => s.id === supplierId)
  // A wallet payout is USDC; only a bank payout is converted into local currency.
  const bankPayout = supplier?.payoutMethod === 'bank'
  useEffect(() => {
    const c = supplier?.bankAccount?.currency
    if (bankPayout && c && cfg.data?.payoutCurrencies.includes(c)) setCurrency(c)
  }, [supplier, bankPayout, cfg.data])
  const payoutCurrency = bankPayout ? currency : 'USD'

  const legs = [{ supplierId, amountUsd: amount, invoiceRef }, ...(extra ?? []).map((l, i) => ({ ...l, invoiceRef: `${invoiceRef}-${i + 2}` }))]
  const total = legs.reduce((s, l) => s + (AMOUNT.test(l.amountUsd) ? Number(l.amountUsd) : 0), 0)
  const feeRate = business.tier === 'premium' ? 0.0015 : 0.003
  const estimate = total + Math.max(total * feeRate, 0.5)
  const short = balance !== undefined && estimate * 1e6 > Number(balance)
  const valid = legs.every((l) => l.supplierId && AMOUNT.test(l.amountUsd) && Number(l.amountUsd) > 0)

  const run = async (what: 'quote' | 'sign', fn: () => Promise<void>) => {
    setBusy(what)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const review = () =>
    run('quote', async () => {
      if (extra) {
        setQuote({ kind: 'batch', b: await backend.createBatch({ businessId: business.id, sourceChain: source.key, payoutCurrency, legs }) })
      } else {
        const p = await backend.createPayment({ businessId: business.id, ...legs[0], sourceChain: source.key, payoutCurrency })
        setQuote({ kind: 'single', paymentId: p.id, q: await backend.quote(p.id) })
      }
    })

  const sign = () =>
    run('sign', async () => {
      if (!quote) return
      await ensure(source.chainId) // the signature's domain is the source chain
      const typed = reviveTypedData((quote.kind === 'single' ? quote.q.typedData : quote.b.typedData) as Parameters<typeof reviveTypedData>[0])
      const signature = await signTypedDataAsync(typed as unknown as Parameters<typeof signTypedDataAsync>[0])
      if (quote.kind === 'single') {
        await backend.sign(quote.paymentId, { quoteId: quote.q.quoteId, quoteToken: quote.q.quoteToken, signature })
        onPaid(quote.paymentId)
      } else {
        await backend.signBatch(quote.b.batchId, { quoteToken: quote.b.quoteToken, signature })
        onPaid(quote.b.payments[0])
      }
      setQuote(null)
      setInvoiceRef(newRef())
      qc.invalidateQueries({ queryKey: ['payments'] })
    })

  if (quote) {
    const q = quote.kind === 'single' ? quote.q : quote.b
    const receives =
      quote.kind === 'batch'
        ? `${quote.b.payments.length} suppliers, ${usd(q.net)} USD in total`
        : payoutCurrency === 'USD'
          ? `${usd(q.net)} USDC`
          : `${quote.q.payoutAmount} ${payoutCurrency}`
    return (
      <Review
        amount={q.amount}
        fee={q.fee}
        receives={receives}
        to={quote.kind === 'single' ? (supplier?.name ?? '') : 'several suppliers'}
        rate={payoutCurrency === 'USD' ? null : `1 USD = ${Number(q.fxRate).toFixed(4)} ${payoutCurrency}`}
        expiresAt={q.expiresAt}
        busy={busy === 'sign'}
        error={error}
        onSign={sign}
        onRequote={review}
        onBack={() => setQuote(null)}
      />
    )
  }

  if (adding || (suppliers.isSuccess && verified.length === 0)) {
    return (
      <AddSupplier
        first={verified.length === 0}
        onCancel={verified.length ? () => setAdding(false) : undefined}
        onAdded={(s) => {
          setAdding(false)
          setSupplierId(s.id)
        }}
      />
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        review()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => (e.target.value === '+' ? setAdding(true) : setSupplierId(e.target.value))}>
            {verified.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.payoutMethod === 'bank' ? `bank (${s.bankAccount?.currency ?? s.country})` : 'USDC wallet'}
              </option>
            ))}
            <option value="+">+ Add a supplier…</option>
          </Select>
        </Field>
        <Field label="Amount (USD)">
          <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>

      {bankPayout && (
        <Field label="Supplier receives in">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {cfg.data?.payoutCurrencies
              .filter((c) => c !== 'USD')
              .map((c) => (
                <option key={c}>{c}</option>
              ))}
          </Select>
        </Field>
      )}

      {extra && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-muted">Also pay, in the same signature:</p>
          {extra.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
              <Select value={l.supplierId} onChange={(e) => setExtra(extra.map((x, k) => (k === i ? { ...x, supplierId: e.target.value } : x)))}>
                {verified.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Input value={l.amountUsd} inputMode="decimal" onChange={(e) => setExtra(extra.map((x, k) => (k === i ? { ...x, amountUsd: e.target.value } : x)))} />
              <button type="button" className="text-sm text-muted hover:text-bad" onClick={() => setExtra(extra.length > 1 ? extra.filter((_, k) => k !== i) : null)}>
                Remove
              </button>
            </div>
          ))}
          {extra.length < 49 && (
            <button type="button" className="text-sm text-brand hover:underline" onClick={() => setExtra([...extra, { supplierId: verified[0]?.id ?? '', amountUsd: '5.00' }])}>
              + Another supplier
            </button>
          )}
        </div>
      )}

      <p className={`text-sm ${short ? 'text-bad' : 'text-muted'}`}>
        About {estimate.toFixed(2)} USDC with the fee ({business.tier === 'premium' ? '0.15%' : '0.3%'}, at least 0.50).{' '}
        {balance !== undefined && `You have ${usd(balance)} USDC on ${source.name}.`}
      </p>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-ink">More options</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Invoice reference">
            <Input value={invoiceRef} maxLength={60} onChange={(e) => setInvoiceRef(e.target.value)} />
          </Field>
          {sources.length > 1 && (
            <Field label="Pay from">
              <Select value={source.key} onChange={(e) => onSource(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {!extra && verified.length > 0 && (
          <button type="button" className="mt-3 text-brand hover:underline" onClick={() => setExtra([{ supplierId: verified[0].id, amountUsd: '5.00' }])}>
            Pay several suppliers with one signature
          </button>
        )}
      </details>

      {error && <Notice tone="bad">{error}</Notice>}
      <Button type="submit" busy={busy === 'quote'} disabled={!valid || !invoiceRef}>
        Review payment
      </Button>
    </form>
  )
}

function Review(props: {
  amount: string
  fee: string
  receives: string
  to: string
  rate: string | null
  expiresAt: string
  busy: boolean
  error: string | null
  onSign: () => void
  onRequote: () => void
  onBack: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.ceil((new Date(props.expiresAt).getTime() - now) / 1000))
  return (
    <div className="space-y-4">
      <dl className="divide-y divide-line rounded-lg border border-line text-sm">
        <Row label="You pay" value={<b className="text-base">{usd(props.amount)} USDC</b>} />
        <Row label="Fee (included)" value={`${usd(props.fee)} USDC`} />
        <Row label={`${props.to} receives`} value={props.receives} />
        {props.rate && <Row label="Exchange rate" value={props.rate} />}
      </dl>
      {props.error && <Notice tone="bad">{props.error}</Notice>}
      {left > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button busy={props.busy} onClick={props.onSign}>
            Sign and pay
          </Button>
          <span className="text-sm text-muted">Price held for {left}s. Your wallet asks for a signature, not a transaction.</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={props.onRequote}>Refresh price</Button>
          <span className="text-sm text-warn">The price expired; nothing was sent.</span>
        </div>
      )}
      <button className="text-sm text-muted hover:text-ink" onClick={props.onBack}>
        ← Change details
      </button>
    </div>
  )
}

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
    <dt className="text-muted">{label}</dt>
    <dd className="text-right">{value}</dd>
  </div>
)

// ---------------------------------------------------------------- add a supplier without leaving the page

function AddSupplier({ first, onAdded, onCancel }: { first: boolean; onAdded: (s: CounterpartyView) => void; onCancel?: () => void }) {
  const { address } = useAccount()
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: '', country: 'IN', wallet: address ?? '', payoutMethod: 'wallet' as 'wallet' | 'bank' })
  const [bank, setBank] = useState({ bankName: 'Mock Bank', accountNumber: '00012345', currency: 'INR' })
  const m = useMutation({
    mutationFn: () => backend.onboard('suppliers', { ...form, bankAccount: form.payoutMethod === 'bank' ? bank : null }),
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      if (s.kybStatus === 'verified') onAdded(s)
    },
  })
  const rejected = m.data && m.data.kybStatus !== 'verified'
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p className="text-sm text-muted">{first ? 'First, add who you are paying.' : 'Add a supplier.'} They are verified right away.</p>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Supplier name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supplier Pvt Ltd" />
        </Field>
        <Field label="Country code">
          <Input value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} />
        </Field>
      </div>
      <Field label="Their wallet on Arc" hint="Testing alone? Leave your own address: you can be both sender and supplier.">
        <Input value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value.trim() })} placeholder="0x…" className="font-mono" />
      </Field>
      <Field label="How they get paid">
        <Select value={form.payoutMethod} onChange={(e) => setForm({ ...form, payoutMethod: e.target.value as 'wallet' | 'bank' })}>
          <option value="wallet">USDC to their wallet</option>
          <option value="bank">Local currency to a bank account (mock bank)</option>
        </Select>
      </Field>
      {form.payoutMethod === 'bank' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Bank">
            <Input value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} />
          </Field>
          <Field label="Account number" hint="Starting with FAIL makes the transfer bounce (refund demo).">
            <Input value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} />
          </Field>
          <Field label="Currency">
            <Input value={bank.currency} maxLength={3} onChange={(e) => setBank({ ...bank, currency: e.target.value.toUpperCase() })} />
          </Field>
        </div>
      )}
      {m.error && <Notice tone="bad">{errorText(m.error)}</Notice>}
      {rejected && (
        <Notice tone="bad">
          {m.data!.name} did not pass verification{m.data!.kybReason ? `: ${m.data!.kybReason}` : ''}. {COUNTRIES_REJECTED}
        </Notice>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" busy={m.isPending} disabled={form.name.length < 2 || form.country.length !== 2 || !/^0x[0-9a-fA-F]{40}$/.test(form.wallet)}>
          Add supplier
        </Button>
        {onCancel && (
          <button type="button" className="text-sm text-muted hover:text-ink" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- payments

function Payments({ businessId, open, setOpen }: { businessId: string; open: string | null; setOpen: (id: string | null) => void }) {
  const list = useQuery({ queryKey: ['payments', 'business', businessId], queryFn: () => backend.payments(`business=${businessId}`), refetchInterval: 2000 })
  // Unsigned drafts (expired prices) are noise here.
  const shown = (list.data ?? []).filter((p) => p.state !== 'CREATED' && p.state !== 'QUOTED')
  const current = open ?? shown[0]?.id ?? null
  return (
    <Card title="Your payments">
      {!shown.length ? (
        <Empty>Payments you send show up here, with their progress.</Empty>
      ) : (
        <div className="space-y-2">
          {shown.map((p) => (
            <PaymentCard key={p.id} p={p} perspective="sender" open={p.id === current} onToggle={() => setOpen(p.id === current ? '' : p.id)}>
              {p.refundAvailable && <RefundButton p={p} />}
            </PaymentCard>
          ))}
        </div>
      )}
    </Card>
  )
}

function RefundButton({ p }: { p: PaymentView }) {
  const cfg = useBackendConfig()
  const { address } = useAccount()
  const ensure = useEnsureChain()
  const { writeContractAsync, isPending, isSuccess } = useWriteContract()
  const mine = address?.toLowerCase() === p.refundTo.toLowerCase()
  if (!cfg.data) return null
  const s = cfg.data.settlement
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warn-soft px-3 py-2 text-sm">
      <span>
        {usd(p.net)} USDC is waiting for {mine ? 'you' : 'the refund address'} on {s.name}.
      </span>
      {mine && (
        <Button
          variant="secondary"
          busy={isPending}
          disabled={isSuccess}
          onClick={async () => {
            await ensure(s.chainId)
            await writeContractAsync({ address: s.escrow, abi: paymentEscrowAbi, functionName: 'withdrawRefund', args: [s.usdc], chainId: s.chainId })
          }}
        >
          {isSuccess ? 'Withdrawn' : 'Withdraw refund'}
        </Button>
      )}
    </div>
  )
}
