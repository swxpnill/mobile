CREATE TABLE "tenant_sync_clock" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_change_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_sync_clock" ADD CONSTRAINT "tenant_sync_clock_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;