# P0-S0 — Public-Ingress Host Inventory (public summary)

- Date: 2026-09-28
- Method: read-only inspection over SSH; nothing was changed.
- This repository is public. Per the hygiene rules in `DEVELOPMENT_MANAGEMENT.md` §9, host identifiers are kept out of Git: addresses, hostnames, accounts, provider/region, OS patch state, SSH details and co-hosted workloads. The full inventory is kept by the development team outside the repository.

## Findings that shape the design

1. **Region matters. The public ingress should be outside mainland China.**
   - On mainland cloud hosts, domain-name HTTP(S) service on ports 80/443 requires an ICP filing for the domain.
   - ChatGPT's connector traffic comes from outside China, so its reliability to a mainland host is uncertain.
   - The Owner therefore chose an ingress host outside mainland China (no ICP requirement). Reachability to `api.openai.com` from that host was confirmed.
2. **Capacity is sufficient.** Both inspected hosts exceed the 1 vCPU / 1 GiB design floor.
3. **M2 (tunnel):** stock `sshd` with TCP forwarding enabled. Remote forwards bind to loopback, so the OpenSSH reverse-forward candidate needs only a dedicated forward-only account.
4. **M3 (gateway):** Python 3.11+ is present, so the gateway can run under `uv` + systemd as an unprivileged user without Docker.
5. **M4 (TLS):** the chosen host may already run a reverse proxy on :443. If so, MCPRelay adds a single SNI-scoped server block in its own file, and that file must not become the :443 default. Change procedure: config test, then reload; rollback = delete the file and reload. A hostname (DNS A record) plus an ACME certificate is required.
6. **Host security baseline (Owner-owned):** key-only SSH and a supported, patched OS are preconditions for the public boundary. A host that falls short may be used for P0/P1 spikes only. Meeting the baseline is a P6 release condition.
