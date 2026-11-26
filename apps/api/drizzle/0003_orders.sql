CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"tenant_id" uuid NOT NULL,
	"series_key" text NOT NULL,
	"fy" text NOT NULL,
	"next_value" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "number_series_pkey" PRIMARY KEY("tenant_id","series_key","fy"),
	CONSTRAINT "number_series_next_value_check" CHECK ("number_series"."next_value" >= 1)
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sub_order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"length" jsonb NOT NULL,
	"ordered_kg" bigint NOT NULL,
	"basic_rate_snapshot" bigint,
	"conversion_snapshot" bigint NOT NULL,
	"rate" bigint NOT NULL,
	"rate_edited" boolean NOT NULL,
	"overprice_per_mt" bigint NOT NULL,
	"closed_kg" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_lines_ordered_kg_check" CHECK ("order_lines"."ordered_kg" > 0),
	CONSTRAINT "order_lines_closed_kg_check" CHECK ("order_lines"."closed_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"customer_id" uuid,
	"broker_id" uuid,
	"commission_per_mt_snapshot" bigint,
	"bill_to_id" uuid,
	"ship_to_id" uuid,
	"pricing_method" text NOT NULL,
	"basic_rate" bigint,
	"notify_customer" boolean NOT NULL,
	"notify_broker" boolean NOT NULL,
	"suffixes_used" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_tenant_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "orders_type_check" CHECK ("orders"."type" in ('customer_broker', 'customer', 'broker_only')),
	CONSTRAINT "orders_pricing_method_check" CHECK ("orders"."pricing_method" in ('basic_conversion', 'direct'))
);
--> statement-breakpoint
CREATE TABLE "sub_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"suffix" text NOT NULL,
	"close_kind" text,
	"close_reason" text,
	"close_note" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sub_orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sub_orders_tenant_order_id_key" UNIQUE("tenant_id","order_id","id"),
	CONSTRAINT "sub_orders_tenant_order_suffix_key" UNIQUE("tenant_id","order_id","suffix"),
	CONSTRAINT "sub_orders_close_kind_check" CHECK ("sub_orders"."close_kind" in ('short_close', 'cancel', 'tolerance'))
);
--> statement-breakpoint
CREATE TABLE "truck_allocations" (
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"net_kg" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "truck_allocations_pkey" PRIMARY KEY("tenant_id","truck_id","order_line_id"),
	CONSTRAINT "truck_allocations_net_kg_check" CHECK ("truck_allocations"."net_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "truck_plan_lines" (
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"planned_kg" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "truck_plan_lines_pkey" PRIMARY KEY("tenant_id","truck_id","order_line_id"),
	CONSTRAINT "truck_plan_lines_planned_kg_check" CHECK ("truck_plan_lines"."planned_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sub_order_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"vehicle_no" text NOT NULL,
	"transporter_id" uuid,
	"driver_name" text NOT NULL,
	"driver_phone" text NOT NULL,
	"lr_no" text,
	"state" text NOT NULL,
	"tare_kg" bigint,
	"gross_kg" bigint,
	"loading_slip_no" text,
	"assigned_at" timestamp with time zone NOT NULL,
	"assigned_by" uuid NOT NULL,
	"at_gate_at" timestamp with time zone,
	"tare_at" timestamp with time zone,
	"tare_device_id" text,
	"weighed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trucks_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "trucks_state_check" CHECK ("trucks"."state" in ('assigned', 'at_gate', 'loading', 'weighed', 'dispatched', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sub_order_fk" FOREIGN KEY ("tenant_id","sub_order_id") REFERENCES "public"."sub_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_broker_fk" FOREIGN KEY ("tenant_id","broker_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_bill_to_fk" FOREIGN KEY ("tenant_id","bill_to_id") REFERENCES "public"."party_addresses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ship_to_fk" FOREIGN KEY ("tenant_id","ship_to_id") REFERENCES "public"."party_addresses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_company_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_allocations" ADD CONSTRAINT "truck_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_allocations" ADD CONSTRAINT "truck_allocations_truck_fk" FOREIGN KEY ("tenant_id","truck_id") REFERENCES "public"."trucks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_allocations" ADD CONSTRAINT "truck_allocations_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_plan_lines" ADD CONSTRAINT "truck_plan_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_plan_lines" ADD CONSTRAINT "truck_plan_lines_truck_fk" FOREIGN KEY ("tenant_id","truck_id") REFERENCES "public"."trucks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_plan_lines" ADD CONSTRAINT "truck_plan_lines_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_sub_order_fk" FOREIGN KEY ("tenant_id","order_id","sub_order_id") REFERENCES "public"."sub_orders"("tenant_id","order_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_plant_fk" FOREIGN KEY ("tenant_id","plant_id") REFERENCES "public"."plants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_transporter_fk" FOREIGN KEY ("tenant_id","transporter_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_assigned_by_fk" FOREIGN KEY ("tenant_id","assigned_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_cancelled_by_fk" FOREIGN KEY ("tenant_id","cancelled_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_tenant_updated_idx" ON "drafts" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "drafts_tenant_created_by_idx" ON "drafts" USING btree ("tenant_id","created_by");--> statement-breakpoint
CREATE INDEX "order_lines_tenant_sub_order_idx" ON "order_lines" USING btree ("tenant_id","sub_order_id","position");--> statement-breakpoint
CREATE INDEX "order_lines_tenant_product_idx" ON "order_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_tenant_customer_idx" ON "orders" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_broker_idx" ON "orders" USING btree ("tenant_id","broker_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_bill_to_idx" ON "orders" USING btree ("tenant_id","bill_to_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_ship_to_idx" ON "orders" USING btree ("tenant_id","ship_to_id");--> statement-breakpoint
CREATE INDEX "sub_orders_tenant_company_idx" ON "sub_orders" USING btree ("tenant_id","company_id");--> statement-breakpoint
CREATE INDEX "truck_allocations_line_idx" ON "truck_allocations" USING btree ("tenant_id","order_line_id");--> statement-breakpoint
CREATE INDEX "truck_plan_lines_line_idx" ON "truck_plan_lines" USING btree ("tenant_id","order_line_id");--> statement-breakpoint
CREATE INDEX "trucks_tenant_sub_order_state_idx" ON "trucks" USING btree ("tenant_id","sub_order_id","state");--> statement-breakpoint
CREATE INDEX "trucks_tenant_transporter_idx" ON "trucks" USING btree ("tenant_id","transporter_id");--> statement-breakpoint
CREATE INDEX "trucks_tenant_plant_idx" ON "trucks" USING btree ("tenant_id","plant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_tenant_loading_slip_key" ON "trucks" USING btree ("tenant_id","loading_slip_no") WHERE "trucks"."loading_slip_no" is not null;