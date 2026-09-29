#!/usr/bin/env bash
# MCPRelay VPS watchdog (run every minute by mcprelay-watchdog.timer).
# systemd already restarts services that EXIT; this catches services that are
# running but not answering. Two consecutive failed checks -> restart.
# Services younger than GRACE seconds are not judged (still starting).
# Installed to /opt/mcprelay/bin by scripts/vps-install.sh; domain from /etc/mcprelay/domain.
set -uo pipefail
GRACE=90
state=/run/mcprelay-watchdog; mkdir -p "$state"
domain=$(cat /etc/mcprelay/domain 2>/dev/null || true)

age() { # seconds since the unit's main process started (0 if not running)
  local pid; pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null)
  [ -n "$pid" ] && [ "$pid" != 0 ] && ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0
}

check() { # name unit command...
  local name=$1 unit=$2; shift 2
  if [ "$(age "$unit")" -lt "$GRACE" ]; then rm -f "$state/$name"; return; fi
  if "$@" >/dev/null 2>&1; then rm -f "$state/$name"; return; fi
  local n=$(( $(cat "$state/$name" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$state/$name"
  echo "watchdog: $name check failed ($n)"
  if [ "$n" -ge 2 ]; then
    echo "watchdog: restarting $unit"
    systemctl restart "$unit"
    rm -f "$state/$name"
  fi
}

caddy_answers() { # Caddy itself: TLS handshake + any HTTP status (even if the gateway behind it is down)
  local code; code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/healthz")
  [ -n "$code" ] && [ "$code" != 000 ]
}

check gateway mcprelay-gateway curl -sf -m 10 http://127.0.0.1:18000/healthz
[ -n "$domain" ] && check caddy mcprelay-caddy caddy_answers
exit 0
