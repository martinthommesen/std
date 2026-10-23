import type { TxMigration } from "../migration.ts";

/** An extension-free UUIDv5 expression for indexed reads before lookup finalization. */
export const migration0024: TxMigration = {
  id: 24,
  kind: "tx",
  name: "record-event-id",
  phase: "expand",
  statements: [
    // RFC 3174's single-block SHA-1: the fixed record event names plus the
    // 16-byte UUID namespace fit within 55 bytes. Not a security digest.
    `CREATE FUNCTION core.record_event_id(namespace uuid, operation text) RETURNS uuid
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      WITH RECURSIVE message AS (
        SELECT pg_catalog.uuid_send(namespace) || pg_catalog.convert_to(CASE operation
          WHEN 'create' THEN 'RecordCreateEvent'
          WHEN 'update' THEN 'RecordAttributeValueChangeEvent'
          WHEN 'delete' THEN 'RecordDeleteEvent' END, 'UTF8') AS bytes
      ), block AS (
        SELECT pg_catalog.encode(bytes, 'hex') || '80' || pg_catalog.repeat('00', 55 - pg_catalog.length(bytes)) ||
          pg_catalog.lpad(pg_catalog.to_hex(pg_catalog.length(bytes) * 8), 16, '0') AS hex FROM message
      ), words(n, w) AS (
        SELECT 16, ARRAY(SELECT ('x' || pg_catalog.substr(hex, i * 8 + 1, 8))::bit(32)
          FROM pg_catalog.generate_series(0, 15) i)::varbit[] FROM block
        UNION ALL
        SELECT n + 1, w || ARRAY[((w[n-2] # w[n-7] # w[n-13] # w[n-15]) << 1) |
          ((w[n-2] # w[n-7] # w[n-13] # w[n-15]) >> 31)] FROM words WHERE n < 80
      ), schedule AS (SELECT w FROM words WHERE n = 80),
      rounds(i, a, b, c, d, e) AS (
        SELECT 0, x'67452301'::bit(32), x'efcdab89'::bit(32), x'98badcfe'::bit(32),
          x'10325476'::bit(32), x'c3d2e1f'::bit(32)
        UNION ALL
        SELECT i + 1,
          (((((a << 5) | (a >> 27))::bigint +
            (CASE WHEN i < 20 THEN (b & c) | (~b & d)
              WHEN i < 40 THEN b # c # d
              WHEN i < 60 THEN (b & c) | (b & d) | (c & d)
              ELSE b # c # d END)::bigint + e::bigint +
            (CASE WHEN i < 20 THEN 1518500249 WHEN i < 40 THEN 1859775393
              WHEN i < 60 THEN 2400959708 ELSE 3395469782 END) + w[i+1]::bit(32)::bigint)
            & 4294967295)::bit(32)), a, ((b << 30) | (b >> 2))::bit(32), c, d
        FROM rounds CROSS JOIN schedule WHERE i < 80
      ), digest AS (
        SELECT pg_catalog.decode(pg_catalog.lpad(pg_catalog.to_hex((a::bigint + 1732584193) & 4294967295), 8, '0') ||
          pg_catalog.lpad(pg_catalog.to_hex((b::bigint + 4023233417) & 4294967295), 8, '0') ||
          pg_catalog.lpad(pg_catalog.to_hex((c::bigint + 2562383102) & 4294967295), 8, '0') ||
          pg_catalog.lpad(pg_catalog.to_hex((d::bigint + 271733878) & 4294967295), 8, '0'), 'hex') AS bytes
        FROM rounds WHERE i = 80
      )
      SELECT pg_catalog.encode(pg_catalog.set_byte(pg_catalog.set_byte(bytes, 6, (pg_catalog.get_byte(bytes, 6) & 15) | 80),
        8, (pg_catalog.get_byte(bytes, 8) & 63) | 128), 'hex')::uuid FROM digest
    $$`,
  ],
};
