# Installs the MCPRelay node package for the current user (no admin rights).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NodeName win01 -VpsHost <vps-host> `
#       -RemotePort 18101 -PublicUrl https://<mcp-domain> [-KnownHostsFile <file>]
#
# Per-user state lives in %APPDATA%\MCPRelay (ACL: current user + SYSTEM only):
#   config.json, bridge.token (generated), node_ed25519 (generated), known_hosts.
# Existing token/key/known_hosts are kept. After a first install, register the
# node on the VPS: vps-install.sh --node <name>:<port>:<node_ed25519.pub>:<bridge.token>
param(
  [Parameter(Mandatory)] [string] $NodeName,
  [Parameter(Mandatory)] [string] $VpsHost,
  [Parameter(Mandatory)] [int] $RemotePort,
  [string] $PublicUrl = '',
  [string] $KnownHostsFile = '',
  [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MCPRelay'),
  [switch] $NoAutostart
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$cfgDir = Join-Path $env:APPDATA 'MCPRelay'
$sshDir = Join-Path $env:WINDIR 'System32\OpenSSH'

Write-Host "== stop running MCPRelay"
Get-Process MCPRelay -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "== copy program files to $InstallDir"
New-Item -ItemType Directory -Force $InstallDir | Out-Null
& robocopy $src $InstallDir /MIR /NFL /NDL /NJH /NJS /NP /XF install.ps1 uninstall.ps1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Copy-Item (Join-Path $src 'uninstall.ps1') $InstallDir

Write-Host "== per-user state in $cfgDir"
New-Item -ItemType Directory -Force $cfgDir | Out-Null
& icacls $cfgDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

$token = Join-Path $cfgDir 'bridge.token'
if (-not (Test-Path $token)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [IO.File]::WriteAllText($token, (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
  Write-Host "   generated bridge.token"
}
$key = Join-Path $cfgDir 'node_ed25519'
if (-not (Test-Path $key)) {
  & (Join-Path $sshDir 'ssh-keygen.exe') -q -t ed25519 -N '""' -C "mcprelay-node-$NodeName" -f $key
  Write-Host "   generated node SSH key"
}
$kh = Join-Path $cfgDir 'known_hosts'
if ($KnownHostsFile) {
  if ((Resolve-Path $KnownHostsFile).Path -ne $kh) { Copy-Item $KnownHostsFile $kh -Force }
}
elseif (-not (Test-Path $kh)) {
  $scan = & (Join-Path $sshDir 'ssh-keyscan.exe') -t ed25519 $VpsHost 2>$null
  if (-not $scan) { throw "could not fetch the VPS host key; pass -KnownHostsFile" }
  $scan | Set-Content -Encoding ascii $kh
  Write-Host "   pinned VPS host key (verify this fingerprint against the VPS):"
  & (Join-Path $sshDir 'ssh-keygen.exe') -lf $kh
}
foreach ($f in $token, $key, $kh) { & icacls $f /inheritance:r /grant:r "${env:USERNAME}:F" "*S-1-5-18:F" | Out-Null }

$config = [ordered]@{
  nodeName   = $NodeName
  vpsHost    = $VpsHost
  tunnelUser = 'mcptunnel'
  remotePort = $RemotePort
  localPort  = 18001
  sshKey     = '%APPDATA%\MCPRelay\node_ed25519'
  knownHosts = '%APPDATA%\MCPRelay\known_hosts'
  publicUrl  = $PublicUrl
}
# Keep Owner settings from an existing config (allowedDirs, protectedDirs, readOnlyDirs, ...).
$cfgFile = Join-Path $cfgDir 'config.json'
if (Test-Path $cfgFile) {
  try {
    $old = Get-Content -Raw $cfgFile | ConvertFrom-Json
    foreach ($p in $old.PSObject.Properties) { if (-not $config.Contains($p.Name)) { $config[$p.Name] = $p.Value } }
  } catch { Write-Warning "existing config.json is unreadable; writing a new one" }
}
$config | ConvertTo-Json | Set-Content -Encoding UTF8 $cfgFile

Write-Host "== Start Menu shortcut"
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'MCPRelay.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk); $s.TargetPath = Join-Path $InstallDir 'MCPRelay.exe'; $s.WorkingDirectory = $InstallDir; $s.Save()

if (-not $NoAutostart) {
  Write-Host "== start with Windows (HKCU Run)"
  Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name MCPRelay -Value ('"' + (Join-Path $InstallDir 'MCPRelay.exe') + '" --minimized')
}

Start-Process (Join-Path $InstallDir 'MCPRelay.exe') -ArgumentList '--minimized'
Write-Host "== installed. Node public key (register on the VPS together with bridge.token):"
Get-Content "$key.pub"
