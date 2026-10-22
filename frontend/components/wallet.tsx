'use client'

import { useAppKit } from '@reown/appkit/react'
import { useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { short } from '@/lib/format'
import { usesAppKit } from '@/lib/wagmi'
import { Button } from './ui'

function AppKitButton() {
  const { open } = useAppKit()
  const { address, isConnected } = useAccount()
  return (
    <Button variant={isConnected ? 'secondary' : 'primary'} onClick={() => open()}>
      {isConnected ? short(address, 4) : 'Connect wallet'}
    </Button>
  )
}

function InjectedButton() {
  const { address, isConnected, connector } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  if (isConnected) {
    return (
      <Button variant="secondary" onClick={() => disconnect()} title="Disconnect" className="whitespace-nowrap">
        {connector?.type === 'demo' && <span className="hidden sm:inline">{connector.name} · </span>}
        {short(address, 4)}
      </Button>
    )
  }
  if (connectors.length === 1) {
    return (
      <Button busy={isPending} onClick={() => connect({ connector: connectors[0] })}>
        Connect wallet
      </Button>
    )
  }
  return (
    <div className="relative">
      <Button busy={isPending} onClick={() => setOpen(!open)}>
        Connect wallet
      </Button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-56 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
          {connectors.map((c) => (
            <button
              key={c.uid}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              onClick={() => {
                setOpen(false)
                connect({ connector: c })
              }}
            >
              {c.type === 'injected' ? 'Browser wallet' : c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const WalletButton = usesAppKit ? AppKitButton : InjectedButton

/** `what`: finishes "Connect your wallet to …", e.g. "pay a supplier". */
export function ConnectFirst({ what }: { what: string }) {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-line bg-white p-10 text-center">
      <p className="mb-4 text-sm text-muted">Connect your wallet to {what}.</p>
      <div className="inline-block">
        <WalletButton />
      </div>
    </div>
  )
}
