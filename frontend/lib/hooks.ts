'use client'

import { useQuery } from '@tanstack/react-query'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'
import { useAccount, useSwitchChain } from 'wagmi'
import { backend } from './api'

export const useBackendConfig = () => useQuery({ queryKey: ['config'], queryFn: backend.config, staleTime: 60_000 })

/** Switches the wallet to `chainId` first: wallets refuse EIP-712 signatures whose domain is another chain. */
export function useEnsureChain() {
  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  return async (target: number) => {
    if (chainId !== target) await switchChainAsync({ chainId: target })
  }
}

/** The ops token stays in this browser tab only. */
export const opsTokenAtom = atomWithStorage(
  'corridor.opsToken',
  '',
  createJSONStorage(() => (typeof window === 'undefined' ? (undefined as unknown as Storage) : sessionStorage)),
)
