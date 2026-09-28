# P0-S0 — VPS Inventory (sanitized)

- Date: 2026-09-28
- Method: read-only inspection over SSH with a dedicated deploy key (`mcprelay-deploy`); nothing was changed.
- The public IP, hostnames and security-sensitive sshd details are intentionally not recorded in this public repository.

## Host

| Item | Value |
|---|---|
| Provider / region | Tencent Cloud, `ap-beijing` (**mainland China**) |
| OS | Ubuntu 24.04.4 LTS, kernel 6.8 |
| CPU / RAM / swap | 4 vCPU / 3.7 GiB (≈3.1 GiB available) / 2 GiB |
| Disk | 59 GiB, 11% used |
| Existing listeners | sshd :22 only; systemd-resolved on loopback. **Nothing on :80/:443** |
| Existing workloads | none besides OS and cloud agents (largest: host-security agent ~105 MiB RSS) |
| Tooling | Python 3.12.3; no Docker, uv, Caddy, nginx or Node |
| sshd | `AllowTcpForwarding yes`, `GatewayPorts no` (remote forwards bind loopback), `ClientAliveInterval 0` |
| Host firewall | ufw inactive; the cloud host-security agent maintains a reject list (it is actively blocking SSH brute-force sources) |

## Consequences for the plan

1. **Capacity:** this is far above the 1 vCPU / 1 GiB design floor, so resources are not a constraint.
2. **M2 (tunnel):** OpenSSH reverse forwarding needs no sshd change beyond a dedicated, forward-only account. `GatewayPorts no` already keeps forwarded ports on VPS loopback.
3. **M3 (gateway):** Python 3.12 is present, so `R0Wi/mcp-gateway` can run under `uv` + systemd without Docker.
4. **M4 (TLS):** nothing to reuse, so Caddy is needed (ADR-0002 F5 fallback).
5. **Mainland-China region (new risk, Owner decision required):**
   - Domain-name HTTP(S) service on ports 80/443 of mainland Tencent Cloud requires an ICP filing (备案) for that domain. Unfiled domains are intercepted.
   - ChatGPT's connector traffic originates from OpenAI's infrastructure outside China. Its reliability to a Beijing host is **unverified**.
   - Compliant options: (a) a domain with ICP filing on this VPS; (b) a VPS region outside mainland China for the public ingress.
   - Either way, reachability from outside China must be proven before AT-CHATGPT, for example from a GitHub-hosted runner.
6. **Security (Owner action recommended, not a project change):** key-based SSH works. Disabling SSH password authentication would remove the brute-force exposure the host-security agent is already reacting to.

---

# Candidate VPS #2 — Alibaba Cloud Seoul (2026-09-28)

Proposed by the Owner after the mainland-region finding above. Inspected read-only as `root` with an Owner-provided key.

| Item | Value |
|---|---|
| Provider / region | Alibaba Cloud, `ap-northeast-2` (Seoul), **no ICP requirement** |
| OS | **CentOS Linux 8, end-of-life since 2021-12** (no security updates), kernel 4.18, OpenSSH 8.0p1 |
| CPU / RAM / swap | 2 vCPU / 1.7 GiB (~0.9 GiB available) / 2 GiB |
| Disk | 40 GiB, 39% used |
| Existing workloads | **shared host.** nginx 1.30 on :80/:443 (catch-all `server_name _` → an existing Owner app on loopback), plus other Owner services. It must not be disturbed |
| Tooling | Python 3.11.9, nginx with `stream`/`ssl_preread`; no Docker, uv, Caddy or Node |
| sshd | key-only auth, `AllowTcpForwarding yes`, `GatewayPorts no` |
| Egress | `api.openai.com` reachable in ~0.4 s |

## Consequences

- **M4:** reuse the existing nginx (ADR-0002 F5). Add one SNI `server` block for the MCPRelay hostname in its own file, so the existing site is untouched.
  - The file must not become the :443 default. conf.d files load alphabetically and the current catch-all has no `default_server`, so a file sorting before it would take over unknown SNI.
  - Change procedure: `nginx -t`, then reload; rollback = delete the file and reload.
- **Certificate:** there is no ACME client yet. A hostname (DNS A record) is required. Use a standalone ACME client with the existing HTTP-01 webroot or DNS-01. Caddy is not needed.
- **M3:** Python 3.11 is present, so run the gateway under `uv` + systemd as a dedicated unprivileged user on loopback. The expected ~100–150 MiB fits the ~0.9 GiB available.
- **M2:** OpenSSH reverse forward to a dedicated forward-only account. `GatewayPorts no` keeps forwards on loopback.
- **Risk:** an end-of-life OS terminating the public OAuth/MCP boundary is below the project's security bar for v1. Acceptable for P0/P1 spikes. A supported OS (rebuild or migration) is a P6 release condition, and the Owner decides when.
