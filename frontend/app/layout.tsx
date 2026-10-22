import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { WalletButton } from '@/components/wallet'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Corridor',
  description: 'Cross-border B2B stablecoin payouts with compliance before any value moves',
}

const nav = [
  { href: '/send', label: 'Pay' },
  { href: '/supplier', label: 'Get paid' },
  { href: '/ops', label: 'Ops', wide: true }, // admin: linked from the home page on phones
]

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Browser extensions (Grammarly and others) add attributes to <html>/<body> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen font-sans antialiased" suppressHydrationWarning>
        <Providers>
          <header className="border-b border-line bg-white">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3 sm:gap-6">
                <Link href="/" className="text-lg font-semibold tracking-tight">
                  Corridor
                </Link>
                <nav className="flex text-sm sm:gap-1">
                  {nav.map((n) => (
                    <Link
                      key={n.href}
                      href={n.href}
                      className={`whitespace-nowrap rounded-md px-2 py-1.5 text-muted hover:bg-slate-100 hover:text-ink sm:px-3 ${'wide' in n ? 'hidden sm:block' : ''}`}
                    >
                      {n.label}
                    </Link>
                  ))}
                </nav>
              </div>
              <WalletButton />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  )
}
