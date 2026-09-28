#!/usr/bin/env bash
# Fails if tracked files contain data that must not be published in this public
# repository (DEVELOPMENT_MANAGEMENT.md §9): public IPv4 addresses, private keys
# or common token formats. Backstop only; review still applies.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

files() { git ls-files -z -- . ':!:*package-lock.json' ':!:scripts/check-public-hygiene.sh'; }
fail=0

# Public IPv4 literals. Allowed: loopback, unspecified, private ranges,
# link-local, CGNAT and the RFC 5737 documentation ranges.
ips=$(files | xargs -0 grep -nIoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' 2>/dev/null || true)
ips=$(printf '%s\n' "$ips" | awk -F: '
  NF >= 3 {
    ip = $NF; split(ip, o, ".")
    if (o[1] > 255 || o[2] > 255 || o[3] > 255 || o[4] > 255) next
    if (ip ~ /^(127\.|0\.|10\.|192\.168\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/) next
    if (ip ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) next
    if (ip ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./) next
    print
  }')
if [ -n "$ips" ]; then
  echo "FAIL: public IPv4 address literal(s) found (use placeholders like <vps-host>):"
  printf '%s\n' "$ips" | sed 's/^/  /'
  fail=1
fi

# Private keys and common credential formats.
secrets=$(files | xargs -0 grep -nIE \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  -e '\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b' \
  -e '\bsk-[A-Za-z0-9_-]{20,}\b' \
  -e '\bAKIA[0-9A-Z]{16}\b' \
  -e '\bLTAI[0-9A-Za-z]{12,}\b' \
  2>/dev/null || true)
if [ -n "$secrets" ]; then
  echo "FAIL: private key or credential-like string found:"
  printf '%s\n' "$secrets" | cut -c1-120 | sed 's/^/  /'
  fail=1
fi

# Private deny-list: identifiers that must never appear (domain, hostnames,
# account names...). Supplied at run time via HYGIENE_DENYLIST (newline- or
# comma-separated), e.g. from a CI secret, so the list itself is never committed.
if [ -n "${HYGIENE_DENYLIST:-}" ]; then
  while IFS= read -r term; do
    term=$(printf '%s' "$term" | tr -d '[:space:]')
    [ -z "$term" ] && continue
    hits=$(files | xargs -0 grep -nIiF -e "$term" 2>/dev/null | cut -d: -f1,2 || true)
    if [ -n "$hits" ]; then
      echo "FAIL: private deny-listed identifier found at:"
      printf '%s\n' "$hits" | sed 's/^/  /'
      fail=1
    fi
  done < <(printf '%s\n' "$HYGIENE_DENYLIST" | tr ',' '\n')
  # Also check commit messages on this branch.
  if git rev-parse -q --verify origin/main >/dev/null; then
    while IFS= read -r term; do
      term=$(printf '%s' "$term" | tr -d '[:space:]')
      [ -z "$term" ] && continue
      git log --format='%B' origin/main..HEAD | grep -qiF -e "$term" && { echo "FAIL: private deny-listed identifier in a commit message"; fail=1; }
    done < <(printf '%s\n' "$HYGIENE_DENYLIST" | tr ',' '\n')
  fi
fi

# Commit author emails on this branch must be GitHub noreply addresses.
if git rev-parse -q --verify origin/main >/dev/null; then
  bad=$(git log --format='%ae' origin/main..HEAD 2>/dev/null | grep -vE '@users\.noreply\.github\.com$|^noreply@github\.com$' || true)
  if [ -n "$bad" ]; then
    echo "FAIL: commit author email is not a GitHub noreply address."
    fail=1
  fi
fi

[ "$fail" -eq 0 ] && echo "public hygiene check passed"
exit "$fail"
