# Security Review — 2026-09 (public summary)

The repository is public. This summary records the controls, tests and residual-risk classes without host identifiers, host versions or other details useful for targeting a deployment (`DEVELOPMENT_MANAGEMENT.md` §9). The full report, with host-specific findings, is kept outside Git by the development team.

## Scope

- public ingress and OAuth;
- ingress host;
- reverse tunnel;
- Windows node (tray app, bridge, Desktop Commander);
- dependency supply chain;
- repository.

Methods:
- configuration and source review;
- port and endpoint probing from an independent external host;
- positive and negative tests;
- `npm audit` / `pip-audit`;
- `systemd-analyze security`.

## Controls added in this review

| Area | Control |
|---|---|
| OAuth consent phishing | The edge allows `/authorize` only for allow-listed client IDs (the Owner's ChatGPT connector; `vps-install.sh --allow-client`). DCR is not exposed. Login sessions last 10 min, so approving a client needs a fresh password. The redirect allow-list covers ChatGPT plus loopback for on-host tests. |
| Node bridge | Bearer token required. It is the gateway's backend credential, and it is scrubbed from Desktop Commander's environment. |
| Unused gateway surface | `/register`, OpenAPI docs, backend-management UI/API and upstream-OAuth routes return 404 at the edge. On-host operator traffic via loopback is exempt. |
| Browser hardening | HSTS, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `nosniff`, `no-referrer`. |
| Service sandboxing | Gateway and Caddy units use `UMask=0077`, `ProtectKernel*`, `RestrictNamespaces`, `SystemCallFilter=@system-service`, empty/limited capability sets. `systemd-analyze security` is 1.4 / 1.6 (OK). |
| Host hardening | `scripts/vps-harden.sh`: drops SUID from unneeded helpers, restricts `sudo` to root/wheel, closes unprivileged kernel-exploit paths (user namespaces, BPF, pointer/dmesg leaks), sets Terrapin-safe SSH ciphers, disables X11 forwarding and password root login, disables LLMNR. |
| Supply chain | Vulnerable transitive `sharp` and `uuid` are pinned to fixed versions via npm `overrides`; `npm audit --omit=dev` reports 0. |
| Grant hygiene | `scripts/vps-revoke.sh`: `--all` (emergency) or `--keep-client` (drop test clients/tokens). |

## Verified unchanged controls

- **Exposure:** externally reachable ports are limited to SSH, HTTP(S) and the Owner's unrelated service. All MCPRelay backends bind loopback.
- **TLS:** 1.2/1.3 only.
- **Gateway credentials and tokens:**
  - login uses a random password with bcrypt and per-IP rate limiting;
  - tokens are hashed with rotating refresh tokens, and authorization codes are single-use.
- **Tunnel account:** cannot get a shell or TTY, cannot `-L` forward, and cannot listen on other ports or on public addresses. Keys are only accepted per-node. The node pins the host key.
- **Node:**
  - per-user secrets are restricted to user + SYSTEM;
  - processes run as the interactive user;
  - Job Objects prevent orphaned process trees.
- **Repository:** no identifiers in history; CI enforces public-hygiene rules.

## Residual risk classes

1. **Real-identity operation.** ChatGPT can run any command as the Owner. `allowedDirectories` limits file tools, not the shell. Prompt injection is the main practical risk. Mitigate operationally: disable the connector when not in use, avoid "always allow" for write/exec tools, and optionally use DC `blockedCommands`.
2. **Ingress host platform.** A host OS without vendor security updates can only be mitigated, not fixed. A supported OS is a P6 release condition.
3. **Co-hosted services.** Other root services on the ingress host are inside the gateway's trust boundary.
4. **Third-party components.** The gateway (single maintainer, pinned commit) and Desktop Commander's dependency tree are pinned. Review diffs before upgrading.
5. **RFC 9207 `iss`** is not returned by the gateway. This is low impact with a single authorization server.

## Emergency procedure

1. Quit the tray app (node offline).
2. `systemctl stop mcprelay-gateway` (public entry offline).
3. `vps-revoke.sh --all` (all grants void).
4. Rotate the node key and/or gateway password by removing them and re-running the installers.
