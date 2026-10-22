'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import type { CounterpartyView } from '@corridor/shared'
import { PaymentCard } from '@/components/payment'
import { Button, Card, Empty, Field, Input, Notice, Select } from '@/components/ui'
import { ConnectFirst } from '@/components/wallet'
import { backend } from '@/lib/api'
import { usd } from '@/lib/format'

type Bank = { bankName: string; accountNumber: string; currency: string }

/** Get paid: verify once, choose wallet or bank, follow incoming payments. */
export default function GetPaidPage() {
  const { address } = useAccount()
  const supplier = useQuery({ queryKey: ['supplier', address], queryFn: () => backend.supplierByWallet(address!), enabled: !!address })
  const [open, setOpen] = useState<string | null>(null)

  if (!address) return <ConnectFirst what="get paid" />
  if (supplier.isLoading) return <p className="text-sm text-muted">Loading…</p>
  if (!supplier.data) return <Onboard wallet={address} onDone={() => supplier.refetch()} />

  const s = supplier.data
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold">{s.name}</h1>
        <p className="text-sm text-muted">
          {s.kybStatus === 'verified' ? 'Verified' : 'Not verified'} · {s.country}
          {s.kybExpiresAt ? ` · until ${new Date(s.kybExpiresAt).toLocaleDateString()}` : ''}
        </p>
      </div>
      {s.kybStatus !== 'verified' && <Notice tone="bad">Verification did not pass, so payments to you are blocked.</Notice>}
      <PayoutMethod supplier={s} />
      <Incoming supplierId={s.id} open={open} setOpen={setOpen} />
    </div>
  )
}

function BankFields({ value, onChange }: { value: Bank; onChange: (v: Bank) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Bank">
        <Input value={value.bankName} onChange={(e) => onChange({ ...value, bankName: e.target.value })} />
      </Field>
      <Field label="Account number" hint="Starting with FAIL makes the transfer bounce (refund demo).">
        <Input value={value.accountNumber} onChange={(e) => onChange({ ...value, accountNumber: e.target.value })} />
      </Field>
      <Field label="Currency">
        <Input value={value.currency} maxLength={3} onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase() })} />
      </Field>
    </div>
  )
}

const MethodSelect = ({ value, onChange }: { value: 'wallet' | 'bank'; onChange: (v: 'wallet' | 'bank') => void }) => (
  <Select value={value} onChange={(e) => onChange(e.target.value as 'wallet' | 'bank')}>
    <option value="wallet">USDC to this wallet</option>
    <option value="bank">Local currency to a bank account (mock bank)</option>
  </Select>
)

function Onboard({ wallet, onDone }: { wallet: Address; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', country: 'IN', payoutMethod: 'wallet' as 'wallet' | 'bank' })
  const [bank, setBank] = useState<Bank>({ bankName: 'Mock Bank', accountNumber: '00012345', currency: 'INR' })
  const m = useMutation({
    mutationFn: () => backend.onboard('suppliers', { ...form, wallet, bankAccount: form.payoutMethod === 'bank' ? bank : null }),
    onSuccess: onDone,
  })
  return (
    <Card title="Get paid" className="mx-auto max-w-2xl">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
      >
        <p className="text-sm text-muted">Tell us who you are and how you want to be paid. A quick sandbox check verifies you right away.</p>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Company name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supplier Pvt Ltd" />
          </Field>
          <Field label="Country code">
            <Input value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        <Field label="How you get paid">
          <MethodSelect value={form.payoutMethod} onChange={(payoutMethod) => setForm({ ...form, payoutMethod })} />
        </Field>
        {form.payoutMethod === 'bank' && <BankFields value={bank} onChange={setBank} />}
        {m.error && <Notice tone="bad">{(m.error as Error).message}</Notice>}
        <Button type="submit" busy={m.isPending} disabled={form.name.length < 2 || form.country.length !== 2}>
          Verify and continue
        </Button>
      </form>
    </Card>
  )
}

function PayoutMethod({ supplier }: { supplier: CounterpartyView }) {
  const [editing, setEditing] = useState(false)
  const [method, setMethod] = useState(supplier.payoutMethod)
  const [bank, setBank] = useState<Bank>(supplier.bankAccount ?? { bankName: 'Mock Bank', accountNumber: '', currency: 'INR' })
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => backend.setPayoutMethod(supplier.id, { payoutMethod: method, bankAccount: method === 'bank' ? bank : null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['supplier'] })
      setEditing(false)
    },
  })
  const current =
    supplier.payoutMethod === 'bank'
      ? `${supplier.bankAccount?.currency} to ${supplier.bankAccount?.bankName} ····${supplier.bankAccount?.accountNumber.slice(-4)}`
      : `USDC to ${supplier.wallet.slice(0, 6)}…${supplier.wallet.slice(-4)} on Arc`
  return (
    <Card
      title="You get paid"
      actions={
        !editing && (
          <button className="text-sm text-brand hover:underline" onClick={() => setEditing(true)}>
            Change
          </button>
        )
      }
    >
      {!editing ? (
        <p className="text-sm">{current}</p>
      ) : (
        <div className="space-y-3">
          <MethodSelect value={method} onChange={setMethod} />
          {method === 'bank' && <BankFields value={bank} onChange={setBank} />}
          {m.error && <Notice tone="bad">{(m.error as Error).message}</Notice>}
          <div className="flex items-center gap-3">
            <Button busy={m.isPending} onClick={() => m.mutate()}>
              Save
            </Button>
            <button className="text-sm text-muted hover:text-ink" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

function Incoming({ supplierId, open, setOpen }: { supplierId: string; open: string | null; setOpen: (id: string | null) => void }) {
  const list = useQuery({ queryKey: ['payments', 'supplier', supplierId], queryFn: () => backend.payments(`supplier=${supplierId}`), refetchInterval: 2000 })
  const shown = (list.data ?? []).filter((p) => p.state !== 'CREATED' && p.state !== 'QUOTED')
  const paid = shown.filter((p) => p.state === 'COMPLETED').reduce((s, p) => s + BigInt(p.net), 0n)
  const current = open ?? shown[0]?.id ?? null
  return (
    <Card title="Payments to you" actions={<span className="text-sm text-muted">Received ${usd(paid)}</span>}>
      {!shown.length ? (
        <Empty>Nothing yet. Payments sent to you show up here as soon as they are signed.</Empty>
      ) : (
        <div className="space-y-2">
          {shown.map((p) => (
            <PaymentCard key={p.id} p={p} perspective="supplier" open={p.id === current} onToggle={() => setOpen(p.id === current ? '' : p.id)}>
              {['PAYOUT_SENT', 'COMPLETED'].includes(p.state) && (
                <a href={backend.pacs008Url(p.id)} target="_blank" rel="noreferrer" className="inline-block text-sm text-brand hover:underline">
                  Download the bank message (ISO 20022 pacs.008)
                </a>
              )}
            </PaymentCard>
          ))}
        </div>
      )}
    </Card>
  )
}
