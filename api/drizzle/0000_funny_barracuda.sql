CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stellar_address" text NOT NULL,
	"type" text NOT NULL,
	"direction" text,
	"amount" text,
	"asset_code" text,
	"asset_issuer" text,
	"counterparty" text,
	"status" text NOT NULL,
	"tx_hash" text,
	"source" text NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_did" text NOT NULL,
	"kind" text NOT NULL,
	"xdr" text NOT NULL,
	"hash_hex" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"privy_did" text PRIMARY KEY NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"stellar_address" text NOT NULL,
	"provisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_stellar_address_unique" UNIQUE("stellar_address")
);
--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_privy_did_merchants_privy_did_fk" FOREIGN KEY ("privy_did") REFERENCES "public"."merchants"("privy_did") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_stellar_address_idx" ON "activity" USING btree ("stellar_address");--> statement-breakpoint
CREATE INDEX "activity_tx_hash_idx" ON "activity" USING btree ("tx_hash");