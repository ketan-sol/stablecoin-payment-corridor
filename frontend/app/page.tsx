import Link from 'next/link'

const actions = [
  { href: '/send', title: 'Pay a supplier', body: 'Pay in USDC with one signature. The supplier gets USDC or local currency.' },
  { href: '/supplier', title: 'Get paid', body: 'Set how you get paid and follow incoming payments.' },
]

export default function Home() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 pt-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Pay a supplier abroad with one signature.</h1>
        <p className="mt-3 text-muted">
          Your USDC moves to Arc through Circle, is checked (KYB, sanctions, Travel Rule), and is then paid out. If anything fails, the
          payment is refunded. It never gets lost halfway.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {actions.map((a) => (
          <Link key={a.href} href={a.href} className="rounded-xl border border-line bg-white p-5 shadow-sm transition hover:border-brand">
            <h2 className="font-semibold">{a.title} →</h2>
            <p className="mt-2 text-sm text-muted">{a.body}</p>
          </Link>
        ))}
      </div>
      <p className="text-sm text-muted">
        Running the platform?{' '}
        <Link href="/ops" className="text-brand hover:underline">
          Ops console
        </Link>{' '}
        for compliance holds, reconciliation and fees.
      </p>
    </div>
  )
}
