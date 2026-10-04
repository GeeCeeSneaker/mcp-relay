# WO-0007 — Managed Repository Reconciliation

## Objective

Implement and field-prove the minimum generic managed-mutation capability defined by ADR-0009 so a remote ChatGPT client can request an exact, identity-checked local Git repository state transition without caller-supplied shell/Git commands.

Tracking: #29.

## Scope

### Required

1. Add the fixed `invoke_managed` dispatcher with server-enforced class membership.
2. Implement `repository_reconcile` only.
3. Add `repository_status` only if implementation proves it is necessary for callers to obtain exact CAS/fingerprint inputs without open-world shell parsing.
4. Add deterministic tests for successful and refused transitions, rollback/partial outcome, allowed-root safety and schema/class enforcement.
5. Update capability catalog, audit/error contract and documentation.
6. Run a real ChatGPT Scheduled Task experiment comparing the existing open-world shell route with the managed route.

### Not in scope

- ADCP-specific deployment tools;
- generic workflow/recipe/plugin framework;
- arbitrary shell/program execution in `managed`;
- arbitrary patch input;
- remote publication/force push/history rewrite;
- branch/worktree deletion;
- package manager, registry, firewall, ACL or credential automation;
- speculative `path_reconcile` / `link_reconcile` implementation.

## Contract constraints

The implementation must remain state-oriented:

```text
expected repository identity/state
+ desired exact commit state
+ exact allowed/preserved dirty identity
-> verified local repository state
```

It must not expose Git command selection to the caller.

### Minimum preconditions

- repository path inside allowed roots;
- exact expected full HEAD SHA;
- exact desired full SHA exists locally;
- exact ref identity when supplied;
- dirty policy is `require_clean` or `preserve_exact` only;
- `preserve_exact` requires exact dirty path set and diff fingerprint;
- unexpected staged/untracked/worktree state fails closed.

### Minimum result

Structured result records:

- operation status;
- before HEAD/ref and dirty fingerprint;
- after HEAD/ref and dirty fingerprint;
- changed-path set;
- whether mutation began;
- whether rollback was attempted and verified;
- explicit partial-state facts if rollback could not be proved.

No caller command text is persisted in audit logs.

## Test matrix

At minimum:

1. clean expected-state transition succeeds;
2. exact dirty delta survives `preserve_exact` unchanged;
3. wrong expected HEAD -> zero mutation;
4. wrong diff fingerprint -> zero mutation;
5. unexpected dirty path -> zero mutation;
6. missing desired commit -> zero mutation;
7. untracked collision -> zero mutation;
8. symlink/junction escape -> refused;
9. failure injected after mutation -> verified rollback or explicit partial result;
10. wrong dispatcher/class -> refused;
11. existing read/write/destructive/exec tests remain green.

## Real Scheduled Task field proof

This is a required exit criterion, not optional evidence.

Use a disposable test repository first. Do not begin with a production repository.

Compare:

A. equivalent state mutation through `invoke_exec/start_process`;
B. state transition through `invoke_managed/repository_reconcile`.

Record:

- connector/app permission configuration;
- whether each action runs unattended, asks for approval, pauses the task or is blocked;
- MCPRelay audit evidence proving whether the invocation reached the node;
- exact catalog/tool annotations/version;
- interactive-chat comparison if useful.

Only after disposable proof may the managed capability be tried on an already-authorized real repository transition.

## Exit criteria

`DEV_ACCEPTED` requires:

- all deterministic tests pass;
- minimalism review passes;
- capability cannot accept arbitrary commands/programs/patches/URLs;
- real Scheduled Task experiment is recorded;
- result states whether the new capability actually improves unattended action availability.

If Scheduled ChatGPT still blocks it, do not add more wrappers. Return to #29 / ADR review and decide whether the capability's safety/clarity value justifies retaining it.
