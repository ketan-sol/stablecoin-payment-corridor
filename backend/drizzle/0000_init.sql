CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"source_chain" text NOT NULL,
	"fee" bigint NOT NULL,
	"net" bigint NOT NULL,
	"permit_nonce" text NOT NULL,
	"deadline" bigint NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"signature" text,
	"pay_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"contract" text NOT NULL,
	"name" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"args" jsonb NOT NULL,
	"key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"wallet" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"kyb_status" text DEFAULT 'pending' NOT NULL,
	"kyb_uid" text,
	"kyb_expires_at" timestamp with time zone,
	"kyb_reason" text,
	"payout_method" text DEFAULT 'wallet' NOT NULL,
	"bank_account" jsonb,
	"webhook_url" text,
	"webhook_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payment_id" uuid,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" bigint NOT NULL,
	"account" text NOT NULL,
	"amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" text NOT NULL,
	"batch_id" uuid,
	"batch_index" integer,
	"business_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"state" text NOT NULL,
	"source_chain" text NOT NULL,
	"amount_usd" text NOT NULL,
	"amount" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"net" bigint NOT NULL,
	"received" bigint,
	"payout_currency" text NOT NULL,
	"fx_rate" text,
	"payout_amount" text,
	"invoice_ref" text NOT NULL,
	"refund_to" text NOT NULL,
	"travel_rule_hash" text NOT NULL,
	"travel_rule_ciphertext" text NOT NULL,
	"permit_nonce" text,
	"deadline" bigint,
	"quote_id" uuid,
	"quote_expires_at" timestamp with time zone,
	"signature" text,
	"escrow_key" text,
	"pay_tx" text,
	"pay_block" bigint,
	"pay_block_hash" text,
	"cctp_message" text,
	"attestation" text,
	"receive_tx" text,
	"receive_block" bigint,
	"freeze_tx" text,
	"payout_method" text,
	"payout_ref" text,
	"payout_status" text,
	"release_tx" text,
	"refund_tx" text,
	"refund_withdraw_tx" text,
	"pacs008" text,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"batch_id" uuid,
	"fee" bigint NOT NULL,
	"fx_rate" text NOT NULL,
	"payout_currency" text NOT NULL,
	"payout_amount" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"corridor" text NOT NULL,
	"payments" integer NOT NULL,
	"gross" bigint NOT NULL,
	"fees" bigint NOT NULL,
	"net" bigint NOT NULL,
	"refunded" bigint NOT NULL,
	"csv" text NOT NULL,
	"matched" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_business_id_counterparties_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_cases" ADD CONSTRAINT "ops_cases_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_counterparties_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_id_counterparties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_unique" ON "chain_events" USING btree ("chain","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "chain_events_key" ON "chain_events" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_kind_wallet" ON "counterparties" USING btree ("kind","wallet");--> statement-breakpoint
CREATE INDEX "journal_lines_account" ON "journal_lines" USING btree ("account");--> statement-breakpoint
CREATE INDEX "journal_lines_entry" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_source_payment_id" ON "payments" USING btree ("source_chain","payment_id");--> statement-breakpoint
CREATE INDEX "payments_state" ON "payments" USING btree ("state");--> statement-breakpoint
CREATE INDEX "payments_business" ON "payments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "payments_supplier" ON "payments" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_reports_day_corridor" ON "settlement_reports" USING btree ("day","corridor");