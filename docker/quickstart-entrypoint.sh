#!/bin/sh
# Select the demo CA only for the bundled database. Empty compose settings
# become absent Config values so URL modes and host defaults still apply.
set -eu
if [ -z "${STD_DATABASE_SSL_MODE:-}" ]; then unset STD_DATABASE_SSL_MODE; fi
if [ -z "${STD_DATABASE_SSL_CA_FILE:-}" ]; then unset STD_DATABASE_SSL_CA_FILE; fi
if [ -z "${STD_DATABASE_SSL_CERT_FILE:-}" ]; then unset STD_DATABASE_SSL_CERT_FILE; fi
if [ -z "${STD_DATABASE_SSL_KEY_FILE:-}" ]; then unset STD_DATABASE_SSL_KEY_FILE; fi
if [ -z "${STD_DATABASE_SSL_SYSTEM_ROOTS:-}" ]; then unset STD_DATABASE_SSL_SYSTEM_ROOTS; fi
if [ -z "${STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE:-}" ]; then unset STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE; fi
if [ -z "${STD_COMPOSE_DATABASE_URL:-}" ]; then
  export STD_DATABASE_SSL_MODE=${STD_DATABASE_SSL_MODE:-verify-full}
  export STD_DATABASE_SSL_CA_FILE=${STD_DATABASE_SSL_CA_FILE:-/std-ca/ca.crt}
fi
exec "$@"
