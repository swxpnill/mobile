CREATE TABLE "broker_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"broker_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"truck_id" uuid,
	"amount_rupees" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"reverses_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"mode" text,
	"utr" text,
	"tds_rupees" bigint,
	"paid_rupees" bigint,
	"paid_on" date,
	"note" text,
	CONSTRAINT "broker_ledger_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "broker_ledger_kind_check" CHECK ("broker_ledger"."kind" in ('earning', 'payment', 'reversal')),
	CONSTRAINT "broker_ledger_reversal_check" CHECK (("broker_ledger"."kind" = 'reversal') = ("broker_ledger"."reverses_id" is not null)),
	CONSTRAINT "broker_ledger_mode_check" CHECK ("broker_ledger"."mode" is null or "broker_ledger"."mode" in ('neft', 'upi', 'cash', 'cheque'))
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"tenant_id" uuid NOT NULL,
	"client_event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"message" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_events_pkey" PRIMARY KEY("tenant_id","client_event_id"),
	CONSTRAINT "sync_events_status_check" CHECK ("sync_events"."status" in ('accepted', 'rejected')),
	CONSTRAINT "sync_events_refusal_check" CHECK (("sync_events"."status" = 'rejected') = ("sync_events"."code" is not null))
);
--> statement-breakpoint
CREATE TABLE "truck_tombstones" (
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"removed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "truck_tombstones_pkey" PRIMARY KEY("tenant_id","truck_id"),
	CONSTRAINT "truck_tombstones_reason_check" CHECK ("truck_tombstones"."reason" in ('gone', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_request_lines" (
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"sub_order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kg" bigint NOT NULL,
	CONSTRAINT "vehicle_request_lines_pkey" PRIMARY KEY("tenant_id","request_id","order_line_id"),
	CONSTRAINT "vehicle_request_lines_kg_check" CHECK ("vehicle_request_lines"."kg" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"party_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"number" text NOT NULL,
	"channel" text NOT NULL,
	"total_kg" bigint NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vehicle_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vehicle_requests_total_kg_check" CHECK ("vehicle_requests"."total_kg" > 0)
);
--> statement-breakpoint
CREATE TABLE "weighment_rejections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_event_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"offset_ms" bigint NOT NULL,
	"event" jsonb NOT NULL,
	"code" text NOT NULL,
	"server_state" text NOT NULL,
	"status" text NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "weighment_rejections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "weighment_rejections_status_check" CHECK ("weighment_rejections"."status" in ('open', 'restored', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "weighments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"kg" bigint NOT NULL,
	"entered_by" uuid NOT NULL,
	"device_id" text NOT NULL,
	"client_event_id" uuid,
	"captured_at_device" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"clock_skew_flag" boolean NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "weighments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "weighments_kind_check" CHECK ("weighments"."kind" in ('tare', 'gross')),
	CONSTRAINT "weighments_kg_check" CHECK ("weighments"."kg" >= 0)
);
--> statement-breakpoint
ALTER TABLE "broker_ledger" ADD CONSTRAINT "broker_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_ledger" ADD CONSTRAINT "broker_ledger_broker_fk" FOREIGN KEY ("tenant_id","broker_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_ledger" ADD CONSTRAINT "broker_ledger_truck_fk" FOREIGN KEY ("tenant_id","truck_id") REFERENCES "public"."trucks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_ledger" ADD CONSTRAINT "broker_ledger_reverses_fk" FOREIGN KEY ("tenant_id","reverses_id") REFERENCES "public"."broker_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_ledger" ADD CONSTRAINT "broker_ledger_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_tombstones" ADD CONSTRAINT "truck_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_tombstones" ADD CONSTRAINT "truck_tombstones_plant_fk" FOREIGN KEY ("tenant_id","plant_id") REFERENCES "public"."plants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_request_lines" ADD CONSTRAINT "vehicle_request_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_request_lines" ADD CONSTRAINT "vehicle_request_lines_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."vehicle_requests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_request_lines" ADD CONSTRAINT "vehicle_request_lines_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_request_lines" ADD CONSTRAINT "vehicle_request_lines_sub_order_fk" FOREIGN KEY ("tenant_id","sub_order_id") REFERENCES "public"."sub_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_requests" ADD CONSTRAINT "vehicle_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_requests" ADD CONSTRAINT "vehicle_requests_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_requests" ADD CONSTRAINT "vehicle_requests_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_requests" ADD CONSTRAINT "vehicle_requests_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighment_rejections" ADD CONSTRAINT "weighment_rejections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighment_rejections" ADD CONSTRAINT "weighment_rejections_truck_fk" FOREIGN KEY ("tenant_id","truck_id") REFERENCES "public"."trucks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighment_rejections" ADD CONSTRAINT "weighment_rejections_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighment_rejections" ADD CONSTRAINT "weighment_rejections_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_truck_fk" FOREIGN KEY ("tenant_id","truck_id") REFERENCES "public"."trucks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_entered_by_fk" FOREIGN KEY ("tenant_id","entered_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_superseded_by_fk" FOREIGN KEY ("tenant_id","superseded_by") REFERENCES "public"."weighments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broker_ledger_tenant_broker_created_idx" ON "broker_ledger" USING btree ("tenant_id","broker_id","created_at");--> statement-breakpoint
CREATE INDEX "broker_ledger_tenant_truck_idx" ON "broker_ledger" USING btree ("tenant_id","truck_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_ledger_one_reversal_key" ON "broker_ledger" USING btree ("tenant_id","reverses_id") WHERE "broker_ledger"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX "truck_tombstones_tenant_plant_removed_idx" ON "truck_tombstones" USING btree ("tenant_id","plant_id","removed_at");--> statement-breakpoint
CREATE INDEX "vehicle_requests_tenant_order_idx" ON "vehicle_requests" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "weighment_rejections_tenant_status_idx" ON "weighment_rejections" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "weighment_rejections_tenant_user_resolved_idx" ON "weighment_rejections" USING btree ("tenant_id","user_id","resolved_at");--> statement-breakpoint
CREATE INDEX "weighment_rejections_tenant_truck_idx" ON "weighment_rejections" USING btree ("tenant_id","truck_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weighments_tenant_client_event_key" ON "weighments" USING btree ("tenant_id","client_event_id") WHERE "weighments"."client_event_id" is not null;--> statement-breakpoint
CREATE INDEX "weighments_tenant_truck_idx" ON "weighments" USING btree ("tenant_id","truck_id");