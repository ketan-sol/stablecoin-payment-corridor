import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`)
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const amount = (name: string) => bigint(name, { mode: 'bigint' }) // token base units, 6 decimals

/** Businesses (senders) and suppliers (receivers). KYB result mirrors the on-chain attestation. */
export const counterparties = pgTable(
  'counterparties',
  {
    id: id(),
    kind: text('kind', { enum: ['business', 'supplier'] }).notNull(),
    name: text('name').notNull(),
    country: text('country').notNull(),
    wallet: text('wallet').notNull(), // EVM address on the settlement chain
    tier: text('tier', { enum: ['standard', 'premium'] }).notNull().default('standard'),
    kybStatus: text('kyb_status', { enum: ['pending', 'verified', 'rejected'] }).notNull().default('pending'),
    kybUid: text('kyb_uid'),
    kybExpiresAt: timestamp('kyb_expires_at', { withTimezone: true }),
    kybReason: text('kyb_reason'),
    payoutMethod: text('payout_method', { enum: ['wallet', 'bank'] }).notNull().default('wallet'),
    bankAccount: jsonb('bank_account').$type<{ bankName: string; accountNumber: string; currency: string }>(),
    webhookUrl: text('webhook_url'),
    webhookSecret: text('webhook_secret'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('counterparty_kind_wallet').on(t.kind, t.wallet)],
)

export const batches = pgTable('batches', {
  id: id(),
  businessId: uuid('business_id').notNull().references(() => counterparties.id),
  sourceChain: text('source_chain').notNull(),
  fee: amount('fee').notNull(),
  net: amount('net').notNull(),
  permitNonce: text('permit_nonce').notNull(),
  deadline: bigint('deadline', { mode: 'number' }).notNull(),
  quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }).notNull(),
  signature: text('signature'),
  payTx: text('pay_tx'),
  createdAt: createdAt(),
})

export const payments = pgTable(
  'payments',
  {
    id: id(),
    paymentId: text('payment_id').notNull(), // bytes32 signed into the intent
    batchId: uuid('batch_id').references(() => batches.id),
    batchIndex: integer('batch_index'), // leg order in the signed BatchIntent
    businessId: uuid('business_id').notNull().references(() => counterparties.id),
    supplierId: uuid('supplier_id').notNull().references(() => counterparties.id),
    state: text('state').notNull(),
    sourceChain: text('source_chain').notNull(),
    amountUsd: text('amount_usd').notNull(),
    amount: amount('amount').notNull(), // gross pulled from the sender (or this leg's amount in a batch)
    fee: amount('fee').notNull(),
    net: amount('net').notNull(),
    received: amount('received'), // what actually landed in escrow
    payoutCurrency: text('payout_currency').notNull(),
    fxRate: text('fx_rate'),
    payoutAmount: text('payout_amount'),
    invoiceRef: text('invoice_ref').notNull(),
    refundTo: text('refund_to').notNull(),
    travelRuleHash: text('travel_rule_hash').notNull(),
    travelRuleCiphertext: text('travel_rule_ciphertext').notNull(),
    permitNonce: text('permit_nonce'),
    deadline: bigint('deadline', { mode: 'number' }),
    quoteId: uuid('quote_id'),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
    signature: text('signature'),
    escrowKey: text('escrow_key'),
    payTx: text('pay_tx'),
    payBlock: bigint('pay_block', { mode: 'number' }),
    payBlockHash: text('pay_block_hash'),
    cctpMessage: text('cctp_message'),
    attestation: text('attestation'),
    receiveTx: text('receive_tx'),
    receiveBlock: bigint('receive_block', { mode: 'number' }),
    freezeTx: text('freeze_tx'),
    payoutMethod: text('payout_method'),
    payoutRef: text('payout_ref'),
    payoutStatus: text('payout_status'),
    releaseTx: text('release_tx'),
    refundTx: text('refund_tx'),
    refundWithdrawTx: text('refund_withdraw_tx'),
    pacs008: text('pacs008'),
    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_source_payment_id').on(t.sourceChain, t.paymentId),
    index('payments_state').on(t.state),
    index('payments_business').on(t.businessId),
    index('payments_supplier').on(t.supplierId),
  ],
)

export const quotes = pgTable('quotes', {
  id: id(),
  paymentId: uuid('payment_id').references(() => payments.id),
  batchId: uuid('batch_id').references(() => batches.id),
  fee: amount('fee').notNull(),
  fxRate: text('fx_rate').notNull(),
  payoutCurrency: text('payout_currency').notNull(),
  payoutAmount: text('payout_amount').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull(), // HMAC over the quote
  status: text('status', { enum: ['active', 'used', 'superseded'] }).notNull().default('active'),
  createdAt: createdAt(),
})

/** Audit log: every state change, actor and reason. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    data: jsonb('data'),
    createdAt: createdAt(),
  },
  (t) => [index('payment_events_payment').on(t.paymentId)],
)

/** Double-entry journal: every entry's lines sum to zero (debits positive, credits negative). */
export const journalEntries = pgTable('journal_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  paymentId: uuid('payment_id').references(() => payments.id),
  kind: text('kind').notNull(),
  token: text('token').notNull(),
  memo: text('memo'),
  createdAt: createdAt(),
})

export const journalLines = pgTable(
  'journal_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryId: bigint('entry_id', { mode: 'number' })
      .notNull()
      .references(() => journalEntries.id),
    account: text('account').notNull(),
    amount: amount('amount').notNull(),
  },
  (t) => [index('journal_lines_account').on(t.account), index('journal_lines_entry').on(t.entryId)],
)

/** Raw on-chain events, stored once (reorg-safe: only past the confirmation depth). */
export const chainEvents = pgTable(
  'chain_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    chain: text('chain').notNull(),
    contract: text('contract').notNull(),
    name: text('name').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockHash: text('block_hash').notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    key: text('key'), // escrow payment key or router payment ID, when the event has one
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chain_events_unique').on(t.chain, t.txHash, t.logIndex), index('chain_events_key').on(t.key)],
)

export const indexerCursors = pgTable('indexer_cursors', {
  key: text('key').primaryKey(),
  block: bigint('block', { mode: 'number' }).notNull(),
})

export const opsCases = pgTable('ops_cases', {
  id: id(),
  paymentId: uuid('payment_id').references(() => payments.id),
  kind: text('kind', { enum: ['compliance', 'payout', 'reconciliation', 'unattributed', 'stuck'] }).notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  title: text('title').notNull(),
  detail: jsonb('detail'),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
})

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  counterpartyId: uuid('counterparty_id')
    .notNull()
    .references(() => counterparties.id),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: createdAt(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
})

export const settlementReports = pgTable(
  'settlement_reports',
  {
    id: id(),
    day: text('day').notNull(), // YYYY-MM-DD (UTC)
    corridor: text('corridor').notNull(), // e.g. "base->arc:INR"
    payments: integer('payments').notNull(),
    gross: amount('gross').notNull(),
    fees: amount('fees').notNull(),
    net: amount('net').notNull(),
    refunded: amount('refunded').notNull(),
    csv: text('csv').notNull(),
    matched: boolean('matched').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('settlement_reports_day_corridor').on(t.day, t.corridor)],
)
