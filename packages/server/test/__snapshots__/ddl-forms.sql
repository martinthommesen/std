-- core set on an empty install

CREATE TABLE "core"."party" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  "contact_medium" jsonb,
  "party_characteristic" jsonb,
  "name" text,
  "status" text DEFAULT 'initialized'::text,
  "external_reference" jsonb,
  CONSTRAINT std_pk_566904e772b9455a8ea15df797c43ae9 PRIMARY KEY (id),
  CONSTRAINT std_uq_566904e772b9455a8ea15df797c43ae9 UNIQUE (id, class_id),
  CONSTRAINT std_sc_566904e772b9455a8ea15df797c43ae9 CHECK (class_id IN ('566904e7-72b9-455a-8ea1-5df797c43ae9'::uuid, 'a1d5e868-1a22-4b6e-8a65-605e046f24ab'::uuid, 'f94b83bf-19a4-4793-b06f-d5b4b0727fac'::uuid)),
  CONSTRAINT std_ck_7292e7395395415ea5b6138c247bad45 CHECK (char_length("name") <= 255)
);

CREATE TRIGGER std_tg_566904e772b9455a8ea15df797c43ae9 BEFORE UPDATE ON "core"."party" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."event_resource" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  CONSTRAINT std_pk_72bf219ebc7546ddb25df75be11d4e99 PRIMARY KEY (id),
  CONSTRAINT std_uq_72bf219ebc7546ddb25df75be11d4e99 UNIQUE (id, class_id),
  CONSTRAINT std_sc_72bf219ebc7546ddb25df75be11d4e99 CHECK (class_id IN ('643d8f21-675c-4f64-82c2-181dcd7407da'::uuid, '72bf219e-bc75-46dd-b25d-f75be11d4e99'::uuid, '8bac18f3-bca8-4f15-b82b-54d4ce3312e4'::uuid))
);

CREATE TRIGGER std_tg_72bf219ebc7546ddb25df75be11d4e99 BEFORE UPDATE ON "core"."event_resource" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."user_role" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  "role" uuid CONSTRAINT std_nn_9640bd3ec66e4b438b4c31489d37dfc8 NOT NULL,
  "user" uuid CONSTRAINT std_nn_f60c3043b96542f2b9eaa81c3f3ee84d NOT NULL,
  CONSTRAINT std_pk_cc91a08ab8854878ad82dd4a806bc787 PRIMARY KEY (id),
  CONSTRAINT std_uq_cc91a08ab8854878ad82dd4a806bc787 UNIQUE (id, class_id),
  CONSTRAINT std_sc_cc91a08ab8854878ad82dd4a806bc787 CHECK (class_id IN ('cc91a08a-b885-4878-ad82-dd4a806bc787'::uuid))
);

CREATE TRIGGER std_tg_cc91a08ab8854878ad82dd4a806bc787 BEFORE UPDATE ON "core"."user_role" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."user" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  "name" text CONSTRAINT std_nn_13160bfb1a944f0ba29bbccf701673c0 NOT NULL,
  "login" text CONSTRAINT std_nn_b3cabaa477cb484592212105b21425eb NOT NULL,
  "active" boolean CONSTRAINT std_nn_df9bb372d557445ca17366ab4e7a9c7c NOT NULL DEFAULT false,
  "password" text,
  "individual" uuid,
  CONSTRAINT std_pk_da385db7b2b74a1da1a942e8e0bb7992 PRIMARY KEY (id),
  CONSTRAINT std_uq_da385db7b2b74a1da1a942e8e0bb7992 UNIQUE (id, class_id),
  CONSTRAINT std_sc_da385db7b2b74a1da1a942e8e0bb7992 CHECK (class_id IN ('da385db7-b2b7-4a1d-a1a9-42e8e0bb7992'::uuid)),
  CONSTRAINT std_ck_13160bfb1a944f0ba29bbccf701673c0 CHECK (char_length("name") <= 255),
  CONSTRAINT std_ck_b3cabaa477cb484592212105b21425eb CHECK (char_length("login") <= 100)
);

CREATE TRIGGER std_tg_da385db7b2b74a1da1a942e8e0bb7992 BEFORE UPDATE ON "core"."user" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."event_topic" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "name" text CONSTRAINT std_nn_3603bdb5a7bc476caad3210225ee0a7a NOT NULL,
  "header_query" text,
  "content_query" text,
  CONSTRAINT std_pk_643d8f21675c4f6482c2181dcd7407da PRIMARY KEY (id),
  CONSTRAINT std_uq_643d8f21675c4f6482c2181dcd7407da UNIQUE (id, class_id),
  CONSTRAINT std_sc_643d8f21675c4f6482c2181dcd7407da CHECK (class_id IN ('643d8f21-675c-4f64-82c2-181dcd7407da'::uuid)),
  CONSTRAINT std_lv_643d8f21675c4f6482c2181dcd7407da FOREIGN KEY (id, class_id) REFERENCES "core"."event_resource" (id, class_id) ON DELETE CASCADE,
  CONSTRAINT std_ck_3603bdb5a7bc476caad3210225ee0a7a CHECK (char_length("name") <= 255),
  CONSTRAINT std_ck_4beb00354dc84e8886c685b979453f7f CHECK (char_length("header_query") <= 255),
  CONSTRAINT std_ck_78d357778f554b638b8790fbdf595f45 CHECK (char_length("content_query") <= 255)
);

CREATE TRIGGER std_tg_643d8f21675c4f6482c2181dcd7407da BEFORE UPDATE ON "core"."event_topic" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."event" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "payload" jsonb CONSTRAINT std_nn_706416a0c21d43469dda283896c78bc9 NOT NULL,
  "topic" uuid CONSTRAINT std_nn_746da8d7b4ac4a60a8ee3fdf6338588e NOT NULL,
  CONSTRAINT std_pk_8bac18f3bca84f15b82b54d4ce3312e4 PRIMARY KEY (id),
  CONSTRAINT std_uq_8bac18f3bca84f15b82b54d4ce3312e4 UNIQUE (id, class_id),
  CONSTRAINT std_sc_8bac18f3bca84f15b82b54d4ce3312e4 CHECK (class_id IN ('8bac18f3-bca8-4f15-b82b-54d4ce3312e4'::uuid)),
  CONSTRAINT std_lv_8bac18f3bca84f15b82b54d4ce3312e4 FOREIGN KEY (id, class_id) REFERENCES "core"."event_resource" (id, class_id) ON DELETE CASCADE
);

CREATE TRIGGER std_tg_8bac18f3bca84f15b82b54d4ce3312e4 BEFORE UPDATE ON "core"."event" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."individual" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "birth_date" date,
  "individual_identification" jsonb,
  "family_name" text CONSTRAINT std_nn_bd4937968b5e49079e126a047dac62e7 NOT NULL,
  "given_name" text CONSTRAINT std_nn_f41d3f02c469428e85cbc6f55a2902de NOT NULL,
  CONSTRAINT std_pk_a1d5e8681a224b6e8a65605e046f24ab PRIMARY KEY (id),
  CONSTRAINT std_uq_a1d5e8681a224b6e8a65605e046f24ab UNIQUE (id, class_id),
  CONSTRAINT std_sc_a1d5e8681a224b6e8a65605e046f24ab CHECK (class_id IN ('a1d5e868-1a22-4b6e-8a65-605e046f24ab'::uuid)),
  CONSTRAINT std_lv_a1d5e8681a224b6e8a65605e046f24ab FOREIGN KEY (id, class_id) REFERENCES "core"."party" (id, class_id) ON DELETE CASCADE,
  CONSTRAINT std_ck_bd4937968b5e49079e126a047dac62e7 CHECK (char_length("family_name") <= 255),
  CONSTRAINT std_ck_f41d3f02c469428e85cbc6f55a2902de CHECK (char_length("given_name") <= 255)
);

CREATE TRIGGER std_tg_a1d5e8681a224b6e8a65605e046f24ab BEFORE UPDATE ON "core"."individual" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "core"."organization" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "trading_name" text,
  "is_legal_entity" boolean CONSTRAINT std_nn_1d91aec4e2a14dd5bf69156a17223d03 NOT NULL DEFAULT false,
  "organization_type" text,
  "exists_from" timestamptz(3),
  "exists_until" timestamptz(3),
  "organization_identification" jsonb,
  CONSTRAINT std_pk_f94b83bf19a44793b06fd5b4b0727fac PRIMARY KEY (id),
  CONSTRAINT std_uq_f94b83bf19a44793b06fd5b4b0727fac UNIQUE (id, class_id),
  CONSTRAINT std_sc_f94b83bf19a44793b06fd5b4b0727fac CHECK (class_id IN ('f94b83bf-19a4-4793-b06f-d5b4b0727fac'::uuid)),
  CONSTRAINT std_lv_f94b83bf19a44793b06fd5b4b0727fac FOREIGN KEY (id, class_id) REFERENCES "core"."party" (id, class_id) ON DELETE CASCADE,
  CONSTRAINT std_ck_0773cefc558a484686b329b188410a1c CHECK (char_length("trading_name") <= 255),
  CONSTRAINT std_ck_433d4fe0c98846f2b97464a76d8a1cd0 CHECK (char_length("organization_type") <= 100)
);

CREATE TRIGGER std_tg_f94b83bf19a44793b06fd5b4b0727fac BEFORE UPDATE ON "core"."organization" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

ALTER TABLE "core"."event" ADD CONSTRAINT std_fk_746da8d7b4ac4a60a8ee3fdf6338588e FOREIGN KEY ("topic") REFERENCES "core"."event_topic" (id);

ALTER TABLE "core"."user_role" ADD CONSTRAINT std_fk_9640bd3ec66e4b438b4c31489d37dfc8 FOREIGN KEY ("role") REFERENCES "core"."role" (id);

ALTER TABLE "core"."user" ADD CONSTRAINT std_fk_e8d96833a2564f3887523f7b5fde3afd FOREIGN KEY ("individual") REFERENCES "core"."individual" (id);

ALTER TABLE "core"."user_role" ADD CONSTRAINT std_fk_f60c3043b96542f2b9eaa81c3f3ee84d FOREIGN KEY ("user") REFERENCES "core"."user" (id);

ALTER TABLE "core"."party" ADD CONSTRAINT std_cb_566904e772b9455a8ea15df797c43ae9 FOREIGN KEY ("created_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."party" ADD CONSTRAINT std_ub_566904e772b9455a8ea15df797c43ae9 FOREIGN KEY ("updated_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."event_resource" ADD CONSTRAINT std_cb_72bf219ebc7546ddb25df75be11d4e99 FOREIGN KEY ("created_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."event_resource" ADD CONSTRAINT std_ub_72bf219ebc7546ddb25df75be11d4e99 FOREIGN KEY ("updated_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."user_role" ADD CONSTRAINT std_cb_cc91a08ab8854878ad82dd4a806bc787 FOREIGN KEY ("created_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."user_role" ADD CONSTRAINT std_ub_cc91a08ab8854878ad82dd4a806bc787 FOREIGN KEY ("updated_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."user" ADD CONSTRAINT std_cb_da385db7b2b74a1da1a942e8e0bb7992 FOREIGN KEY ("created_by") REFERENCES "core"."user" (id);

ALTER TABLE "core"."user" ADD CONSTRAINT std_ub_da385db7b2b74a1da1a942e8e0bb7992 FOREIGN KEY ("updated_by") REFERENCES "core"."user" (id);

CREATE UNIQUE INDEX std_ix_4941e6708c9b4a1aa75893854cef07bb ON "core"."user" (casefold("login" COLLATE pg_unicode_fast));

CREATE UNIQUE INDEX std_ix_716293908e5a49909bf146e9c8abd338 ON "core"."user_role" ("user", "role");

CREATE UNIQUE INDEX std_ix_ea3846ee82994428a276df9d66b5d5b3 ON "core"."user" ("individual");

-- acme set

CREATE SCHEMA "acme";

CREATE TABLE "acme"."asset" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  "purchased_on" date,
  "status" text,
  "name" text CONSTRAINT std_nn_6438aa02739d46c094ccecea44488210 NOT NULL,
  "cost" numeric(12,2),
  "owner" uuid,
  "docked_to" uuid,
  CONSTRAINT std_pk_989151bba69f4b18b73d9e19a4e7514c PRIMARY KEY (id),
  CONSTRAINT std_uq_989151bba69f4b18b73d9e19a4e7514c UNIQUE (id, class_id),
  CONSTRAINT std_sc_989151bba69f4b18b73d9e19a4e7514c CHECK (class_id IN ('6a365314-6d1b-4e4d-b166-73f29f808504'::uuid, '87363f0e-8122-4569-8fc8-ec8c5277a71b'::uuid, '989151bb-a69f-4b18-b73d-9e19a4e7514c'::uuid)),
  CONSTRAINT std_ck_5ed5f951f6da47ed967ac726af083d44 CHECK (char_length("status") <= 32),
  CONSTRAINT std_ck_6438aa02739d46c094ccecea44488210 CHECK (char_length("name") <= 120)
);

CREATE TRIGGER std_tg_989151bba69f4b18b73d9e19a4e7514c BEFORE UPDATE ON "acme"."asset" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "acme"."laptop" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "serial" text,
  "disk_key" text,
  CONSTRAINT std_pk_6a3653146d1b4e4db16673f29f808504 PRIMARY KEY (id),
  CONSTRAINT std_uq_6a3653146d1b4e4db16673f29f808504 UNIQUE (id, class_id),
  CONSTRAINT std_sc_6a3653146d1b4e4db16673f29f808504 CHECK (class_id IN ('6a365314-6d1b-4e4d-b166-73f29f808504'::uuid)),
  CONSTRAINT std_lv_6a3653146d1b4e4db16673f29f808504 FOREIGN KEY (id, class_id) REFERENCES "acme"."asset" (id, class_id) ON DELETE CASCADE,
  CONSTRAINT std_ck_3598942454b44d99adfe649cb4bac237 CHECK (char_length("serial") <= 64),
  CONSTRAINT std_ck_6972d40e504c492cae3c3b2021f6e21f CHECK (char_length("disk_key") <= 128)
);

CREATE TRIGGER std_tg_6a3653146d1b4e4db16673f29f808504 BEFORE UPDATE ON "acme"."laptop" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

CREATE TABLE "acme"."monitor" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  "size_inches" integer,
  CONSTRAINT std_pk_87363f0e812245698fc8ec8c5277a71b PRIMARY KEY (id),
  CONSTRAINT std_uq_87363f0e812245698fc8ec8c5277a71b UNIQUE (id, class_id),
  CONSTRAINT std_sc_87363f0e812245698fc8ec8c5277a71b CHECK (class_id IN ('87363f0e-8122-4569-8fc8-ec8c5277a71b'::uuid)),
  CONSTRAINT std_lv_87363f0e812245698fc8ec8c5277a71b FOREIGN KEY (id, class_id) REFERENCES "acme"."asset" (id, class_id) ON DELETE CASCADE
);

CREATE TRIGGER std_tg_87363f0e812245698fc8ec8c5277a71b BEFORE UPDATE ON "acme"."monitor" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();

ALTER TABLE "acme"."asset" ADD CONSTRAINT std_fk_6a373fb5bd184d7fb0b4182470f5421e FOREIGN KEY ("owner") REFERENCES "core"."user" (id);

ALTER TABLE "acme"."asset" ADD CONSTRAINT std_fk_83ec3835689846f3ae2eafdbc3f5d407 FOREIGN KEY ("docked_to") REFERENCES "acme"."asset" (id);

ALTER TABLE "acme"."asset" ADD CONSTRAINT std_cb_989151bba69f4b18b73d9e19a4e7514c FOREIGN KEY ("created_by") REFERENCES "core"."user" (id);

ALTER TABLE "acme"."asset" ADD CONSTRAINT std_ub_989151bba69f4b18b73d9e19a4e7514c FOREIGN KEY ("updated_by") REFERENCES "core"."user" (id);

-- fields, indexes and an override on tables with rows

ALTER TABLE "acme"."laptop" ADD COLUMN "asset_tag" text CONSTRAINT std_nn_00000000000040008000000000000001 NOT NULL DEFAULT 'none'::text;

ALTER TABLE "acme"."laptop" ADD CONSTRAINT std_ck_00000000000040008000000000000001 CHECK (char_length("asset_tag") <= 20) NOT VALID;

ALTER TABLE "acme"."asset" ADD COLUMN "retired_flag" boolean CONSTRAINT std_nn_00000000000040008000000000000002 NOT NULL DEFAULT false;

ALTER TABLE "acme"."monitor" ADD COLUMN "buddy" uuid;

ALTER TABLE "acme"."asset" ALTER COLUMN "purchased_on" SET DEFAULT '2026-01-01'::date;

ALTER TABLE "acme"."monitor" ADD CONSTRAINT std_fk_00000000000040008000000000000003 FOREIGN KEY ("buddy") REFERENCES "acme"."asset" (id) NOT VALID;

ALTER TABLE "acme"."laptop" VALIDATE CONSTRAINT std_ck_00000000000040008000000000000001;

ALTER TABLE "acme"."monitor" VALIDATE CONSTRAINT std_fk_00000000000040008000000000000003;

CREATE UNIQUE INDEX CONCURRENTLY std_ix_00000000000040008000000000000004 ON "acme"."laptop" (casefold("serial" COLLATE pg_unicode_fast));

CREATE INDEX CONCURRENTLY std_ix_00000000000040008000000000000005 ON "acme"."asset" (casefold("status" COLLATE pg_unicode_fast));
