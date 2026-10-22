/** The plan's payment state machine. The chain is the settlement record; these states are the business record. */
export const PAYMENT_STATES = [
  'CREATED',
  'QUOTED',
  'SIGNED',
  'FUNDED_SOURCE',
  'IN_TRANSIT',
  'ESCROWED',
  'COMPLIANCE_CLEARED',
  'PAYOUT_SENT',
  'COMPLETED',
  'FROZEN',
  'REFUNDING',
  'REFUNDED',
] as const

export type PaymentState = (typeof PAYMENT_STATES)[number]

export const TERMINAL_STATES: readonly PaymentState[] = ['COMPLETED', 'REFUNDED']

/** Allowed moves. Anything else is a bug and is refused by the orchestrator. */
export const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CREATED: ['QUOTED'],
  QUOTED: ['QUOTED', 'SIGNED'],
  SIGNED: ['FUNDED_SOURCE', 'QUOTED'], // QUOTED again if the relay failed and nothing moved
  FUNDED_SOURCE: ['IN_TRANSIT'],
  IN_TRANSIT: ['ESCROWED'],
  ESCROWED: ['COMPLIANCE_CLEARED', 'FROZEN', 'REFUNDING', 'REFUNDED'],
  COMPLIANCE_CLEARED: ['PAYOUT_SENT', 'FROZEN', 'REFUNDING', 'ESCROWED'],
  PAYOUT_SENT: ['COMPLETED', 'REFUNDING', 'FROZEN', 'ESCROWED'], // ESCROWED: a release reverted; back through the gate
  FROZEN: ['ESCROWED', 'REFUNDED'],
  REFUNDING: ['REFUNDED'],
  COMPLETED: [],
  REFUNDED: [],
}

export const canTransition = (from: PaymentState, to: PaymentState) => TRANSITIONS[from].includes(to)

/** What the sender and supplier see: never a raw hash as the main message. */
export const STATE_LABELS: Record<PaymentState, string> = {
  CREATED: 'Draft',
  QUOTED: 'Quote ready',
  SIGNED: 'Signed',
  FUNDED_SOURCE: 'Funds sent',
  IN_TRANSIT: 'In transit',
  ESCROWED: 'Compliance check',
  COMPLIANCE_CLEARED: 'Compliance cleared',
  PAYOUT_SENT: 'Paying out',
  COMPLETED: 'Paid out',
  FROZEN: 'On hold for review',
  REFUNDING: 'Refunding',
  REFUNDED: 'Refunded',
}

/** The happy path, for timelines. */
export const HAPPY_PATH: readonly PaymentState[] = [
  'QUOTED',
  'SIGNED',
  'FUNDED_SOURCE',
  'IN_TRANSIT',
  'ESCROWED',
  'COMPLIANCE_CLEARED',
  'PAYOUT_SENT',
  'COMPLETED',
]
