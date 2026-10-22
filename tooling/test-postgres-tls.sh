#!/bin/sh
# One isolated Postgres 18, a fresh PKI and a random host port. Never compose.
set -eu
umask 077
fixture=$(mktemp -d "${TMPDIR:-/tmp}/std-tls.XXXXXXXX")
container="std-tls-test-$(basename "$fixture")"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT HUP INT TERM
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=std-test-ca -keyout "$fixture/ca.key" -out "$fixture/ca.crt" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=wrong-ca -keyout "$fixture/wrong.key" -out "$fixture/wrong.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout "$fixture/server.key" -out "$fixture/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$fixture/extensions"
openssl x509 -req -in "$fixture/server.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" -CAcreateserial -days 2 -extfile "$fixture/extensions" -out "$fixture/server.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=std-client -keyout "$fixture/client.key" -out "$fixture/client.csr" 2>/dev/null
printf 'extendedKeyUsage=clientAuth\n' > "$fixture/client-extensions"
openssl x509 -req -in "$fixture/client.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" -CAcreateserial -days 2 -extfile "$fixture/client-extensions" -out "$fixture/client.crt" 2>/dev/null
# Persist TLS in postgresql.auto.conf so the same server can reload ssl=off later.
cat > "$fixture/tls.sql" <<'SQL'
ALTER SYSTEM SET ssl = on;
ALTER SYSTEM SET ssl_cert_file = '/fixture/server.crt';
ALTER SYSTEM SET ssl_key_file = '/tmp/server.key';
ALTER SYSTEM SET ssl_ca_file = '/fixture/ca.crt';
SQL
chmod 644 "$fixture/tls.sql"
# Only the server's key enters the container. The CA key stays in this temp dir.
chmod 700 "$fixture"
chmod 600 "$fixture/server.key"
chmod 644 "$fixture/server.crt" "$fixture/ca.crt"
docker run -d --name "$container" -p 127.0.0.1::5432 \
  -e POSTGRES_USER=std -e POSTGRES_PASSWORD=std -e POSTGRES_DB=std \
  -v "$PWD/docker/postgres-tls.sh:/fixture/postgres-tls.sh:ro" \
  -v "$fixture/tls.sql:/docker-entrypoint-initdb.d/tls.sql:ro" \
  -v "$fixture/ca.crt:/fixture/ca.crt:ro" \
  -v "$fixture/server.crt:/fixture/server.crt:ro" -v "$fixture/server.key:/fixture/server.key:ro" \
  --entrypoint sh postgres:18 -ec \
  'cp /fixture/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres' >/dev/null
attempt=0
until docker exec "$container" pg_isready -h 127.0.0.1 -U std -d std >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then docker logs "$container"; exit 1; fi
  sleep 1
done
port=$(docker port "$container" 5432/tcp | sed 's/.*://')
STD_TLS_TEST_URL="postgres://std:std@localhost:$port/std" \
STD_TLS_TEST_CA_FILE="$fixture/ca.crt" \
STD_TLS_TEST_WRONG_CA_FILE="$fixture/wrong.crt" \
STD_TLS_TEST_CLIENT_CERT_FILE="$fixture/client.crt" \
STD_TLS_TEST_CLIENT_KEY_FILE="$fixture/client.key" \
  pnpm exec vitest run --config packages/server/vitest-tls.config.ts --reporter verbose postgres-tls.integration.ts

# The tooling wire client and the values tests have separate connection builders.
STD_DATABASE_URL="postgres://std:std@localhost:$port/std" STD_DATABASE_SSL_MODE=verify-full STD_DATABASE_SSL_CA_FILE="$fixture/ca.crt" pnpm check:postgres
STD_DATABASE_URL="postgres://std:std@localhost:$port/std" STD_DATABASE_SSL_MODE=verify-full STD_DATABASE_SSL_CA_FILE="$fixture/ca.crt" pnpm exec vitest run --project values postgres-text

# Exercise the compose certificate bootstrap without starting another server.
# `true` is passed through the official entrypoint after certificate generation.
docker exec "$container" sh /fixture/postgres-tls.sh true >/dev/null 2>&1
docker exec "$container" sh -ec '
  openssl verify -CAfile /std-ca/ca.crt /var/lib/postgresql/std-tls/server.crt
  openssl x509 -in /var/lib/postgresql/std-tls/server.crt -noout -checkhost postgres
  test "$(stat -c %a /var/lib/postgresql/std-tls/server.key)" = 600
  test ! -e /var/lib/postgresql/std-tls/ca.key
  before=$(sha256sum /std-ca/ca.crt)
  sh /fixture/postgres-tls.sh true
  test "$before" = "$(sha256sum /std-ca/ca.crt)"
  # Replace the leaf with one expiring tomorrow; startup must renew the CA too.
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=expiring \
    -keyout /var/lib/postgresql/std-tls/server.key -out /var/lib/postgresql/std-tls/server.crt
  sh /fixture/postgres-tls.sh true
  test "$before" != "$(sha256sum /std-ca/ca.crt)"
  openssl x509 -in /var/lib/postgresql/std-tls/server.crt -noout -checkend 2592000
  # Expiry of the CA independently triggers renewal.
  before=$(sha256sum /std-ca/ca.crt)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=expiring-ca \
    -keyout /tmp/expiring-ca.key -out /var/lib/postgresql/std-tls/ca.crt
  sh /fixture/postgres-tls.sh true
  test "$before" != "$(sha256sum /std-ca/ca.crt)"
  test "$(stat -c %a /var/lib/postgresql/std-tls/server.key)" = 600
'

# Reuse this same isolated container to prove mandatory TLS has no fallback.
docker exec "$container" psql -U std -d std -c 'ALTER SYSTEM SET ssl = off' >/dev/null
docker exec "$container" psql -U std -d std -c 'SELECT pg_reload_conf()' >/dev/null
attempt=0
until [ "$(docker exec "$container" psql -U std -d std -Atc 'SHOW ssl')" = off ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then exit 1; fi
  sleep 1
done
STD_TLS_TEST_URL="postgres://std:std@localhost:$port/std" \
  pnpm exec vitest run --config packages/server/vitest-tls.config.ts --reporter verbose postgres-no-tls.integration.ts
