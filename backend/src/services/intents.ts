import type { Address, Hex } from 'viem'
import {
  batchTypedData,
  paymentTypedData,
  type BatchIntent,
  type PaymentIntent,
  type Permit,
} from '@corridor/shared'
import type { Config } from '../config'
import type { Payment } from './transitions'

/** Rebuilds exactly what the sender signed from the stored payment, for the wallet and for the relayer. */
export function intentFor(cfg: Config, p: Payment, receiver: Address): PaymentIntent {
  return {
    paymentId: p.paymentId as Hex,
    receiver,
    refundTo: p.refundTo as Address,
    fee: p.fee,
    destinationDomain: cfg.network.settlement.domain,
    travelRuleHash: p.travelRuleHash as Hex,
  }
}

export function permitFor(cfg: Config, source: string, amount: bigint, nonce: string, deadline: number): Permit {
  return {
    permitted: { token: cfg.network.sources[source].token, amount },
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  }
}

export function typedDataFor(cfg: Config, p: Payment, _sender: Address, receiver: Address) {
  const src = cfg.network.sources[p.sourceChain]
  return paymentTypedData(
    { chainId: src.chainId, permit2: src.permit2!, router: src.router },
    permitFor(cfg, p.sourceChain, p.amount, p.permitNonce!, p.deadline!),
    intentFor(cfg, p, receiver),
  )
}

/** A batch's legs, in the signed order. */
export function batchIntentFor(cfg: Config, legs: { p: Payment; receiver: Address }[], fee: bigint, refundTo: Address): BatchIntent {
  return {
    legs: legs.map(({ p, receiver }) => ({
      paymentId: p.paymentId as Hex,
      receiver,
      amount: p.net,
      travelRuleHash: p.travelRuleHash as Hex,
    })),
    refundTo,
    fee,
    destinationDomain: cfg.network.settlement.domain,
  }
}

export function batchTypedDataFor(cfg: Config, source: string, batch: BatchIntent, nonce: string, deadline: number) {
  const src = cfg.network.sources[source]
  const total = batch.legs.reduce((s, l) => s + l.amount, 0n) + batch.fee
  return batchTypedData(
    { chainId: src.chainId, permit2: src.permit2!, router: src.router },
    permitFor(cfg, source, total, nonce, deadline),
    batch,
  )
}
