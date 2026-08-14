CREATE TABLE "ramp_customers" (
	"privy_did" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'etherfuse' NOT NULL,
	"customer_id" text NOT NULL,
	"blockchain_wallet_id" text,
	"bank_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ramp_customers" ADD CONSTRAINT "ramp_customers_privy_did_merchants_privy_did_fk" FOREIGN KEY ("privy_did") REFERENCES "public"."merchants"("privy_did") ON DELETE no action ON UPDATE no action;