#!/usr/bin/env bash
# Revoke gateway OAuth grants (run as root on the VPS).
#
#   vps-revoke.sh --all                          # emergency: every client must re-authorize
#   vps-revoke.sh --keep-client <client_id>      # cleanup: drop every other client and its tokens
#
# The gateway is stopped during the change and started again afterwards.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
mode=${1:-}; keep=${2:-}
case "$mode" in
  --all) keep='' ;;
  --keep-client) [ -n "$keep" ] || { echo "--keep-client needs a client_id" >&2; exit 2; } ;;
  *) echo "usage: vps-revoke.sh --all | --keep-client <client_id>" >&2; exit 2 ;;
esac
db=/var/lib/mcprelay/gateway.db
systemctl stop mcprelay-gateway
trap 'systemctl start mcprelay-gateway' EXIT
python3 - "$db" "$keep" <<'PY'
import sqlite3, sys
db, keep = sys.argv[1:]
c = sqlite3.connect(db)
before = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in ("oauth_clients", "access_tokens", "refresh_tokens")}
if keep:
    c.execute("delete from access_tokens where client_id != ?", (keep,))
    c.execute("delete from refresh_tokens where client_id != ?", (keep,))
    c.execute("delete from auth_codes")
    c.execute("delete from oauth_clients where client_id != ?", (keep,))
else:
    c.execute("delete from access_tokens")
    c.execute("delete from refresh_tokens")
    c.execute("delete from auth_codes")
c.commit()
after = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in before}
for t in before:
    print(f"{t:16s} {before[t]:4d} -> {after[t]}")
PY
echo "gateway restarting"
