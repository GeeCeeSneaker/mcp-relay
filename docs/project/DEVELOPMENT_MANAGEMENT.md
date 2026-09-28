# Development Management Handbook

## 1. Governance model

MCPRelay uses **bounded team autonomy**, not per-task command-and-control. Project architecture, trust boundaries, v1 requirements and acceptance criteria are frozen enough for a competent development team to execute from start to finish. The team should make ordinary engineering decisions itself.

Repository state is authoritative over transient chat/terminal context.

## 2. Roles

### Owner
Owns product direction, acceptable trust/risk, credentials/infrastructure authority and final material architecture decisions.

### Project Manager / Independent Reviewer
Owns project-level requirements, architecture boundaries, acceptance contract and independent review. May update scheduling/priorities based on repository evidence.

**Permanent execution boundary:** without explicit Owner authorization for a specific action, Reviewer must not operate the local PC/VPS, run local shell commands, install/upgrade software, start/stop services, change firewall/network/deployment configuration or generate missing runtime evidence personally.

### Development Team
Owns implementation execution inside `MASTER_IMPLEMENTATION_PLAN.md`:
- task decomposition and scheduling;
- branches/Issues/PRs;
- implementation/refactoring/bug fixing;
- same-responsibility dependency selection/substitution;
- tests and runtime evidence;
- documentation/handoffs;
- ordinary merges according to CI/repository discipline;
- moving to later pre-authorized phases when exit criteria pass.

The team does not need Reviewer approval for every C0/C1 implementation step.

## 3. Authority levels

### A — autonomous
No approval required before action:
- implementation/refactor/tests/docs;
- scripts/config templates;
- dependency patch/minor updates with compatibility testing;
- replacing a candidate component with an equivalent component inside the same logical responsibility, when total architecture does not expand;
- changing internal file layout/APIs;
- issue/PR decomposition;
- phase ordering/parallelism consistent with dependencies;
- deleting unnecessary layers/code;
- continuing to the next pre-authorized phase after exit criteria are recorded.

Record material component substitutions in ADR/DEVLOG.

### B — architecture escalation
Pause the affected design choice and request review before implementing:
- new persistent service category;
- new database/control plane/message broker;
- general VPN/private network;
- custom MCP/auth/tunnel protocol;
- materially new public endpoint/trust boundary;
- enterprise RBAC/policy platform;
- architecture that materially increases resource/ops burden to solve a local incompatibility.

Unrelated authorized work may continue.

### C — Owner authorization
Required before:
- destructive/irreversible infrastructure or user-data action;
- exposing new sensitive local services/data publicly;
- weakening agreed authentication/encryption;
- new paid external service commitment;
- use/change of Owner credentials/secrets outside already authorized deployment workflow;
- material product-scope change.

## 4. Progress states

For phase/work-package tracking use:
`PLANNED / IN_PROGRESS / DEV_ACCEPTED / BLOCKED / PROJECT_REVIEW / PROJECT_VERIFIED / REOPENED`.

`DEV_ACCEPTED` means the development team believes the documented acceptance tests pass and may continue to dependent pre-authorized work. It is not independent project verification.

Reviewer can later mark `PROJECT_VERIFIED` or `REOPENED` at milestone/release checkpoints.

## 5. Review cadence

Independent Reviewer review is expected at meaningful integration points, especially:
- first real ChatGPT E2E path;
- Windows packaged runtime;
- multi-node contract;
- Linux parity;
- v1 release candidate;
- any Level-B/C escalation.

The team does not need to stop all engineering while a non-blocking review is pending. Reviewer findings that invalidate an accepted foundation become P0 remediation and downstream work must be reconciled.

## 6. PR/merge discipline

- PRs should reference phase/work package and acceptance evidence.
- Exact versions/important runtime evidence belong in repository docs or PR/Issue discussion.
- Prefer peer review when multiple developers are available.
- A solo implementation agent may merge pre-authorized C0/C1 work after required CI/evidence is recorded if repository protection permits; this is still only `DEV_ACCEPTED`, not independent verification.
- Do not merge known secret leakage, auth bypass or architecture-escalation changes without resolution.

## 7. Handoff standard

Material handoff records:
- objective/phase;
- exact commit/PR;
- components/versions;
- what changed;
- tests/CI;
- runtime/E2E evidence;
- resource evidence when relevant;
- current state;
- blockers/known issues;
- next recommended actions;
- scope/architecture deviations.

Do not leave critical state only in chat or terminal history.

## 8. Minimalism review

At each integration PR/milestone ask:
- What permanent process/dependency was added?
- Could an existing component own this responsibility?
- Can any prior layer now be removed?
- Did a compatibility workaround become unnecessary architecture?
- Did we write custom code for commodity infrastructure?
- Can config/scripts be simpler?

Unnecessary complexity can be a blocking Reviewer finding even if functionality works.

## 9. Security/repository hygiene

Secrets, private keys, auth tokens, cookies and sensitive machine data stay out of Git. Sanitized evidence must be sufficient to verify boundaries/results.

**The repository is public.** In addition to secrets, never commit anything that identifies or profiles the Owner's infrastructure:
- host addresses (public IPs), hostnames, the MCPRelay domain name, account/user names;
- key or credential file names/paths;
- cloud provider/account/region of specific hosts;
- OS version or patch state of specific hosts, SSH/firewall settings of specific hosts;
- other workloads running on shared hosts;
- local machine identifiers (computer name, OS build, user profile paths).

Configuration in Git uses placeholders (`<vps-host>`, `<mcp-domain>`, `<node-name>`). Real values live only in deployment-time files outside Git or in gitignored paths (`config/local/`, `secrets/`, `evidence/local/`).

Evidence records the generic finding, not the identifying detail. For example: "ingress host outside mainland China, sshd forwards bind loopback", not the provider, region or IP.

CI enforces a minimum automatically (`scripts/check-public-hygiene.sh`): no public IPv4 literals, private keys or common token formats in tracked files. The check is a backstop, not a substitute for review.

## 10. Final Definition of Done

v1 is complete only when `P6` acceptance passes on an exact release head, actual ChatGPT proof exists, docs/reproducibility/resource/minimalism checks are complete and independent Reviewer records `PROJECT_VERIFIED` or explicit `PASS_WITH_CONDITIONS`.
