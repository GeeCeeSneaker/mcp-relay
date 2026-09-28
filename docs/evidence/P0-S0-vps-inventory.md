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
