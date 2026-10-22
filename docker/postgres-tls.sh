#!/bin/sh
# Runs as root before the official entrypoint drops to postgres. On an existing
# data volume this also enables TLS without re-running initdb.
set -eu
private=/var/lib/postgresql/std-tls
public=/std-ca
mkdir -p "$private" "$public"
chmod 700 "$private"
if [ ! -s "$private/server.key" ] || [ ! -s "$private/server.crt" ]; then
  umask 077
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
    -subj /CN=std-quickstart-ca -keyout "$private/ca.key" -out "$private/ca.crt"
  openssl req -newkey rsa:3072 -nodes -subj /CN=postgres \
    -keyout "$private/server.key" -out "$private/server.csr"
  printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n' > "$private/extensions"
  openssl x509 -req -in "$private/server.csr" -CA "$private/ca.crt" \
    -CAkey "$private/ca.key" -CAcreateserial -days 365 \
    -extfile "$private/extensions" -out "$private/server.crt"
  rm -f "$private/ca.key" "$private/server.csr" "$private/ca.srl" "$private/extensions"
fi
# The app receives only this public trust anchor, never any private key.
cp "$private/ca.crt" "$public/ca.crt"
chmod 755 "$public"
chmod 644 "$public/ca.crt"
chown -R postgres:postgres "$private"
exec docker-entrypoint.sh "$@" \
  -c ssl=on -c "ssl_cert_file=$private/server.crt" -c "ssl_key_file=$private/server.key" \
  -c ssl_min_protocol_version=TLSv1.2
