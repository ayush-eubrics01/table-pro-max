#!/usr/bin/env bash
# Starts/stops disposable database containers for integration tests.
# Containers are named tpm-test-* and use tmpfs storage: nothing persists after `down`.
# Never point integration tests at a real database.
set -euo pipefail

PG_PORT="${TPM_TEST_PG_PORT:-55432}"
MY_PORT="${TPM_TEST_MYSQL_PORT:-53306}"
MA_PORT="${TPM_TEST_MARIADB_PORT:-53307}"
SSH_PORT="${TPM_TEST_SSH_PORT:-52222}"
REDIS_PORT="${TPM_TEST_REDIS_PORT:-56379}"
MSSQL_PORT="${TPM_TEST_MSSQL_PORT:-51433}"
# SQL Server wants an upper-case letter, a digit and a symbol in the sa password.
MSSQL_PASS="Tpm_test_pw1"
PASS="tpm_test_pw"
SSH_PASS="tpm_ssh_pw"
NET="tpm-test-net"
KEY_DIR="${TPM_TEST_KEY_DIR:-${TMPDIR:-/tmp}/tpm-test-ssh}"

up() {
  docker run -d --rm --name tpm-test-postgres -p "127.0.0.1:${PG_PORT}:5432" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB=tpm_test postgres:16-alpine >/dev/null
  docker run -d --rm --name tpm-test-mysql -p "127.0.0.1:${MY_PORT}:3306" --tmpfs /var/lib/mysql \
    -e MYSQL_ROOT_PASSWORD="$PASS" -e MYSQL_DATABASE=tpm_test mysql:8.4 >/dev/null
  docker run -d --rm --name tpm-test-mariadb -p "127.0.0.1:${MA_PORT}:3306" --tmpfs /var/lib/mysql \
    -e MARIADB_ROOT_PASSWORD="$PASS" -e MARIADB_DATABASE=tpm_test mariadb:11.4 >/dev/null
  docker run -d --rm --name tpm-test-redis -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
  mssql_up
  wait_ready
  ssh_up
  print_env
}

# A throwaway SSH bastion that can reach the test PostgreSQL as host "tpm-test-postgres".
ssh_up() {
  docker network create "$NET" >/dev/null 2>&1 || true
  docker network connect "$NET" tpm-test-postgres >/dev/null 2>&1 || true
  docker run -d --rm --name tpm-test-ssh --network "$NET" -p "127.0.0.1:${SSH_PORT}:22" alpine:3.22 sh -c \
    "apk add --no-cache openssh >/dev/null && ssh-keygen -A && adduser -D tpm && echo 'tpm:${SSH_PASS}' | chpasswd \
     && mkdir -p /home/tpm/.ssh && chown tpm /home/tpm/.ssh && chmod 700 /home/tpm/.ssh \
     && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o AllowTcpForwarding=yes -o PermitRootLogin=no" >/dev/null
  mkdir -p "$KEY_DIR"
  rm -f "$KEY_DIR/id_ed25519" "$KEY_DIR/id_ed25519.pub"
  ssh-keygen -q -t ed25519 -N "" -f "$KEY_DIR/id_ed25519" -C tpm-test
  for i in $(seq 1 60); do
    if docker exec tpm-test-ssh sh -c 'pgrep sshd >/dev/null'; then break; fi
    sleep 1
  done
  docker exec -i tpm-test-ssh sh -c 'cat > /home/tpm/.ssh/authorized_keys && chown tpm /home/tpm/.ssh/authorized_keys && chmod 600 /home/tpm/.ssh/authorized_keys' < "$KEY_DIR/id_ed25519.pub"
}

# SQL Server Developer edition: free for development and testing, never shipped. Starting it
# accepts Microsoft's licence for that use (ACCEPT_EULA=Y).
mssql_up() {
  docker run -d --rm --name tpm-test-mssql -p "127.0.0.1:${MSSQL_PORT}:1433" \
    -e ACCEPT_EULA=Y -e MSSQL_PID=Developer -e MSSQL_SA_PASSWORD="$MSSQL_PASS" \
    mcr.microsoft.com/mssql/server:2022-latest >/dev/null
}

mssql_ready() {
  for i in $(seq 1 90); do
    docker exec tpm-test-mssql /opt/mssql-tools18/bin/sqlcmd -C -S 127.0.0.1 -U sa -P "$MSSQL_PASS" \
      -Q "IF DB_ID('tpm_test') IS NULL CREATE DATABASE tpm_test" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "SQL Server did not become ready" >&2
  return 1
}

wait_ready() {
  for i in $(seq 1 90); do
    ok=0
    docker exec tpm-test-postgres pg_isready -U postgres -d tpm_test >/dev/null 2>&1 && ok=$((ok+1))
    docker exec tpm-test-mysql mysqladmin ping -h 127.0.0.1 -uroot -p"$PASS" --silent >/dev/null 2>&1 && ok=$((ok+1))
    docker exec tpm-test-mariadb mariadb-admin ping -h 127.0.0.1 -uroot -p"$PASS" --silent >/dev/null 2>&1 && ok=$((ok+1))
    [ "$ok" = 3 ] && mssql_ready && return 0
    sleep 2
  done
  echo "databases did not become ready" >&2
  return 1
}

print_env() {
  echo "export TPM_TEST_PG_URL=postgres://postgres:${PASS}@127.0.0.1:${PG_PORT}/tpm_test?sslmode=disable"
  echo "export TPM_TEST_MYSQL_URL=mysql://root:${PASS}@127.0.0.1:${MY_PORT}/tpm_test?ssl-mode=disabled"
  echo "export TPM_TEST_MARIADB_URL=mariadb://root:${PASS}@127.0.0.1:${MA_PORT}/tpm_test?ssl-mode=disabled"
  echo "export TPM_TEST_REDIS_URL=redis://127.0.0.1:${REDIS_PORT}/15"
  echo "export TPM_TEST_MSSQL_URL=sqlserver://sa:${MSSQL_PASS}@127.0.0.1:${MSSQL_PORT}/tpm_test?sslmode=require"
  echo "export TPM_TEST_SSH=127.0.0.1:${SSH_PORT}:tpm:${SSH_PASS}"
  echo "export TPM_TEST_SSH_KEY=${KEY_DIR}/id_ed25519"
}

down() {
  docker rm -f tpm-test-postgres tpm-test-mysql tpm-test-mariadb tpm-test-ssh tpm-test-redis tpm-test-mssql >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  env) print_env ;;
  ssh) ssh_up && print_env ;;
  mssql) mssql_up && mssql_ready && print_env ;;
  redis) docker run -d --rm --name tpm-test-redis -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null && print_env ;;
  *) echo "usage: $0 up|down|env|ssh|redis|mssql" >&2; exit 2 ;;
esac
