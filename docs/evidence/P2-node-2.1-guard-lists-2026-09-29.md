# Evidence — node server v2.1.0: guard lists for file capabilities, 2026-09-29

## Decision (Owner)

- The file roots are widened to the user profile plus the whole data drive. Before this, work on the data drive could only be done through shell commands, which lack the file capabilities' safeguards (atomic writes, link-safe deletion, root protection).
- System folders get a denylist.

File roots and guard lists are a **guardrail against mistakes, not a security boundary**. Exec capabilities keep running with the user's full rights, which is the real-identity requirement. The controls are OAuth with the client allow-list, and the Owner's per-class confirmation in ChatGPT.

## Guard lists (checked after realpath, so links and junctions cannot bypass them)

| List | Effect | Default entries (Windows) |
|---|---|---|
| protected | never read, listed, searched or changed. Listings show `(protected, not listed)`, and search skips the folder | `%APPDATA%\MCPRelay` (bridge token, node SSH key, config); `~\.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`; Windows `Credentials` and DPAPI `Protect`; Chrome/Edge/Firefox profiles |
| read-only | readable, never written, edited, created, moved or deleted | `%SystemRoot%`, Program Files (both), ProgramData, `%LOCALAPPDATA%\MCPRelay` (logs), the installed program, the server's own code folder, and the audit-log folder. On every drive: `$Recycle.Bin`, `System Volume Information`, `Recovery`, `Config.Msi`, and page/hibernate/swap files |

Additional rules:
- a folder that contains a guarded folder can be neither deleted nor moved;
- config keys `protectedDirs` and `readOnlyDirs` (env `MCPRELAY_PROTECTED_DIRS` / `MCPRELAY_READONLY_DIRS`) add entries;
- Linux defaults: the same home credential folders are protected, and the system trees (`/etc`, `/usr`, `/var`, …) are read-only.

Tray app 1.2.0 passes the new keys. `install.ps1` now **keeps existing config settings** on reinstall; before this fix, a reinstall dropped `allowedDirs`.

## Results

| Check | Result |
|---|---|
| Local smoke, both eras, destructive suite; test guard folders set via env | ALL PASS, including 2 new guard checks |
| Protected-folder check | read, write, list and remove refused; the parent listing hides the contents; search skips the folder |
| Read-only-folder check | read OK; write, edit, create, remove and move refused; the file is unchanged; the parent can be neither removed nor moved |
| `compare-ext.mjs` (Windows) | ALL PASS |
| Real layout, read-only probe (roots = profile + data drive) | bridge token, node config folder, `~\.ssh` key and DPAPI folder refused. MCPRelay logs readable but not writable. Data drive listed, but its `$RECYCLE.BIN` not writable. Installed program not writable. `C:\Windows` outside the roots. Search does not find `bridge.token`. No stray files left behind |
| Live, through the public gateway | node 2.1.0; `file_roots` = profile + data drive; data drive listable; bridge token refused |
| CI | runs both guard checks with guard folders in the runner's home |
