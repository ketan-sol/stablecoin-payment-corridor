'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtom } from 'jotai'
import { useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useReadContract, useWriteContract } from 'wagmi'
import { paymentEscrowAbi, type PaymentView } from '@corridor/shared'
import { StatusChip } from '@/components/payment'
import { Button, Card, Empty, Field, Input, Notice, Stat } from '@/components/ui'
import { api } from '@/lib/api'
import { API_URL } from '@/lib/env'
import { short, usd, when } from '@/lib/format'
import { opsTokenAtom, useBackendConfig, useEnsureChain } from '@/lib/hooks'

type Tab = 'queue' | 'cases' | 'recon' | 'health'

export default function OpsPage() {
  const [token, setToken] = useAtom(opsTokenAtom)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>('queue')
  if (!token) {
    return (
      <Card title="Ops console" className="max-w-md">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft) setToken(draft)
          }}
        >
          <Field label="Ops token" hint="Backend OPS_TOKEN (dev default: dev-ops-token). Kept in this tab only.">
            <Input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          <Button type="submit" disabled={!draft}>
            Open console
          </Button>
        </form>
      </Card>
    )
  }
  const tabs: [Tab, string][] = [
    ['queue', 'Compliance queue'],
    ['cases', 'Ops cases'],
    ['recon', 'Reconciliation'],
    ['health', 'Relayer & fees'],
  ]
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Ops console</h1>
        <button className="text-sm text-muted hover:text-ink" onClick={() => setToken('')}>
          Sign out
        </button>
      </div>
      <div className="flex gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand font-medium' : 'border-transparent text-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'queue' && <Queue token={token} />}
      {tab === 'cases' && <Cases token={token} />}
      {tab === 'recon' && <Recon token={token} />}
      {tab === 'health' && <Health token={token} />}
    </div>
  )
}

// ---------------------------------------------------------------- compliance queue: two approvers, on-chain

function Queue({ token }: { token: string }) {
  const q = useQuery({ queryKey: ['ops', 'queue'], queryFn: () => api<PaymentView[]>('GET', '/ops/queue', undefined, token), refetchInterval: 2000 })
  const frozen = (q.data ?? []).filter((p) => p.state === 'FROZEN')
  const others = (q.data ?? []).filter((p) => p.state !== 'FROZEN')
  return (
    <div className="space-y-6">
      <Card title={`Frozen payments (${frozen.length})`}>
        <p className="mb-4 text-sm text-muted">
          Release or refund needs two different compliance officers. Each approves from their own wallet; the escrow enforces it.
        </p>
        {!frozen.length ? <Empty>Nothing on hold.</Empty> : <div className="space-y-3">{frozen.map((p) => <FrozenItem key={p.id} p={p} />)}</div>}
      </Card>
      <Card title="In escrow or paying out">
        {!others.length ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {others.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>
                  {p.business.name} → {p.supplier.name} · ${usd(p.net)} · {p.invoiceRef}
                </span>
                <StatusChip state={p.state} label={p.label} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

const ACTION = ['none', 'unfreeze', 'refund'] as const

function FrozenItem({ p }: { p: PaymentView }) {
  const cfg = useBackendConfig()
  const { address } = useAccount()
  const ensure = useEnsureChain()
  const { writeContractAsync, isPending, error } = useWriteContract()
  const s = cfg.data?.settlement
  const key = p.escrowKey as Hex
  const proposal = useReadContract({ address: s?.escrow, abi: paymentEscrowAbi, functionName: 'proposals', args: [key], chainId: s?.chainId, query: { enabled: !!s, refetchInterval: 2000 } })
  const role = useReadContract({ address: s?.escrow, abi: paymentEscrowAbi, functionName: 'COMPLIANCE_OFFICER', chainId: s?.chainId, query: { enabled: !!s } })
  const isOfficer = useReadContract({
    address: s?.escrow,
    abi: paymentEscrowAbi,
    functionName: 'hasRole',
    args: [role.data!, address!],
    chainId: s?.chainId,
    query: { enabled: !!s && !!role.data && !!address },
  })
  const [officer, action] = proposal.data ?? []
  const pending = action !== undefined && action !== 0
  const mine = pending && officer?.toLowerCase() === address?.toLowerCase()
  const approve = async (fn: 'unfreeze' | 'refund') => {
    await ensure(s!.chainId)
    await writeContractAsync({ address: s!.escrow, abi: paymentEscrowAbi, functionName: fn, args: [key], chainId: s!.chainId })
    proposal.refetch()
  }
  return (
    <div className="rounded-lg border border-red-200 bg-bad-soft/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">
            {p.business.name} → {p.supplier.name} · ${usd(p.net)}
          </div>
          <div className="text-xs text-muted">
            {p.invoiceRef} · key {short(key)} · updated {when(p.updatedAt)}
          </div>
          {p.lastError && <div className="mt-2 text-sm text-bad">{p.lastError}</div>}
        </div>
        <StatusChip state={p.state} label={p.label} />
      </div>
      <div className="mt-3 text-sm">
        {pending ? (
          <span>
            Approval 1 of 2: <b>{ACTION[Number(action)]}</b> proposed by {short(officer, 4)}
            {mine ? ' (you). A different officer must confirm.' : '. Confirm the same action to execute it.'}
          </span>
        ) : (
          <span className="text-muted">No proposal yet.</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {!address ? (
          <span className="text-sm text-muted">Connect an officer wallet to approve.</span>
        ) : isOfficer.data === false ? (
          <span className="text-sm text-muted">The connected wallet is not a compliance officer.</span>
        ) : (
          <>
            <Button variant="secondary" busy={isPending} onClick={() => approve('unfreeze')}>
              Approve release (unfreeze)
            </Button>
            <Button variant="danger" busy={isPending} onClick={() => approve('refund')}>
              Approve refund
            </Button>
          </>
        )}
      </div>
      {error && <div className="mt-2 text-sm text-bad">{(error as { shortMessage?: string }).shortMessage ?? error.message}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- ops cases

interface OpsCase {
  id: string
  paymentId: string | null
  kind: string
  status: string
  title: string
  detail: unknown
  createdAt: string
  resolution: string | null
}

function Cases({ token }: { token: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['ops', 'cases'], queryFn: () => api<OpsCase[]>('GET', '/ops/cases', undefined, token), refetchInterval: 3000 })
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: string }) => api('POST', `/ops/cases/${id}/resolve`, { resolution }, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops', 'cases'] }),
  })
  const [notes, setNotes] = useState<Record<string, string>>({})
  return (
    <Card title="Ops cases">
      {!q.data?.length ? (
        <Empty>No cases.</Empty>
      ) : (
        <ul className="space-y-3">
          {q.data.map((c) => (
            <li key={c.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs uppercase">{c.kind}</span>
                  <span className="text-sm font-medium">{c.title}</span>
                </div>
                <span className={`text-xs ${c.status === 'open' ? 'text-warn' : 'text-ok'}`}>{c.status}</span>
              </div>
              <div className="mt-1 text-xs text-muted">
                {when(c.createdAt)}
                {c.paymentId ? ` · payment ${c.paymentId.slice(0, 8)}` : ''}
              </div>
              {c.detail != null && <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(c.detail, null, 2)}</pre>}
              {c.status === 'open' ? (
                <div className="mt-2 flex gap-2">
                  <Input placeholder="Resolution note" value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                  <Button variant="secondary" disabled={(notes[c.id] ?? '').length < 3} onClick={() => resolve.mutate({ id: c.id, resolution: notes[c.id] })}>
                    Resolve
                  </Button>
                </div>
              ) : (
                <div className="mt-2 text-xs text-muted">Resolution: {c.resolution}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- reconciliation and settlement reports

interface Report {
  id: string
  day: string
  corridor: string
  payments: number
  gross: string
  fees: string
  net: string
  refunded: string
  matched: boolean
}

function Recon({ token }: { token: string }) {
  const reports = useQuery({ queryKey: ['ops', 'reports'], queryFn: () => api<Report[]>('GET', '/ops/reports', undefined, token) })
  const run = useMutation({
    mutationFn: () => api<{ mismatches: { title: string; paymentId: string | null }[] }>('POST', '/ops/reconcile', {}, token),
    onSuccess: () => reports.refetch(),
  })
  const download = async (r: Report) => {
    const res = await fetch(`${API_URL}/ops/reports/${r.id}.csv`, { headers: { 'x-ops-token': token } })
    const url = URL.createObjectURL(await res.blob())
    Object.assign(document.createElement('a'), { href: url, download: `settlement-${r.day}-${r.corridor}.csv` }).click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="space-y-6">
      <Card title="Reconciliation" actions={<Button busy={run.isPending} onClick={() => run.mutate()}>Run now</Button>}>
        <p className="text-sm text-muted">Matches the ledger (business record) against the escrow (settlement record). Runs daily; any mismatch opens a case.</p>
        {run.data &&
          (run.data.mismatches.length ? (
            <ul className="mt-3 space-y-1 text-sm text-bad">
              {run.data.mismatches.map((m, i) => (
                <li key={i}>• {m.title}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-3">
              <Notice tone="ok">Ledger and chain agree.</Notice>
            </div>
          ))}
      </Card>
      <Card title="Settlement reports">
        {!reports.data?.length ? (
          <Empty>No reports yet; run reconciliation.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-2">Day</th>
                <th>Corridor</th>
                <th className="text-right">Payments</th>
                <th className="text-right">Gross</th>
                <th className="text-right">Fees</th>
                <th className="text-right">Refunded</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {reports.data.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{r.day}</td>
                  <td>
                    {r.corridor} {!r.matched && <span className="text-bad">· mismatch</span>}
                  </td>
                  <td className="text-right tabular-nums">{r.payments}</td>
                  <td className="text-right tabular-nums">${usd(r.gross)}</td>
                  <td className="text-right tabular-nums">${usd(r.fees)}</td>
                  <td className="text-right tabular-nums">${usd(r.refunded)}</td>
                  <td className="text-right">
                    <button className="text-brand hover:underline" onClick={() => download(r)}>
                      CSV
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- relayer health, fees, ledger

function Health({ token }: { token: string }) {
  const cfg = useBackendConfig()
  const health = useQuery({
    queryKey: ['ops', 'health'],
    queryFn: () => api<{ chains: { chain: string; ok: boolean; block: number | null; relayerNative: string | null; tls?: string | null; error?: string }[]; queueDepth: number; payments: Record<string, number>; failedWebhooks: number }>('GET', '/ops/health', undefined, token),
    refetchInterval: 3000,
  })
  const fees = useQuery({ queryKey: ['ops', 'fees'], queryFn: () => api<{ chain: string; token: string; balance: string }[]>('GET', '/ops/fees', undefined, token), refetchInterval: 5000 })
  const ledger = useQuery({ queryKey: ['ops', 'ledger'], queryFn: () => api<Record<string, string>>('GET', '/ops/ledger', undefined, token), refetchInterval: 5000 })
  const warp = useMutation({ mutationFn: () => api<{ chainTime: number }>('POST', '/ops/dev/warp', { seconds: 72 * 3600 + 60 }, token) })
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Relayer health">
        <div className="space-y-3">
          {health.data?.chains.map((c) => (
            <div key={c.chain} className="flex items-center justify-between text-sm">
              <span>
                <span className={`mr-2 inline-block h-2 w-2 rounded-full ${c.ok ? 'bg-ok' : 'bg-bad'}`} />
                {c.chain}
              </span>
              <span className="text-muted">
                {c.ok ? `block ${c.block} · relayer gas ${Number(c.relayerNative).toFixed(4)}` : c.error}
                {c.tls && (
                  <span className={c.tls.includes('MLKEM') ? '' : 'text-bad'} title="TLS key exchange with this RPC">
                    {' · '}TLS {c.tls.includes('MLKEM') ? 'post-quantum' : 'classical'} ({c.tls})
                  </span>
                )}
              </span>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-4 pt-2">
            <Stat label="Queue depth" value={health.data?.queueDepth ?? '…'} />
            <Stat label="Failed webhooks" value={health.data?.failedWebhooks ?? '…'} />
          </div>
          {health.data && (
            <ul className="space-y-1 pt-2 text-sm">
              {Object.entries(health.data.payments).map(([k, n]) => (
                <li key={k} className="flex justify-between">
                  <span className="text-muted">{k}</span>
                  <span className="tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <Card title="Fee vault balances">
        <ul className="space-y-1 text-sm">
          {fees.data?.map((f) => (
            <li key={f.chain} className="flex justify-between">
              <span>{f.chain}</span>
              <span className="tabular-nums">
                {usd(f.balance)} {f.token}
              </span>
            </li>
          ))}
        </ul>
        {cfg.data?.network === 'local' && (
          <div className="mt-6 border-t border-line pt-4">
            <p className="mb-2 text-sm text-muted">Local demo: jump the chain past the 72 h refund window (demo step 5).</p>
            <Button variant="secondary" busy={warp.isPending} onClick={() => warp.mutate()}>
              Fast-forward 72 h
            </Button>
            {warp.data && <span className="ml-3 text-sm text-ok">Chain time now {new Date(warp.data.chainTime * 1000).toLocaleString()}</span>}
          </div>
        )}
      </Card>
      <Card title="Ledger balances" className="lg:col-span-2">
        <p className="mb-3 text-sm text-muted">Double-entry: debits positive, credits negative; every entry sums to zero.</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {Object.entries(ledger.data ?? {}).map(([acct, v]) => (
            <li key={acct} className="flex justify-between gap-4 rounded bg-slate-50 px-2 py-1">
              <span className="truncate font-mono text-xs">{acct}</span>
              <span className="tabular-nums">{usd(v)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
