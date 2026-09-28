# Removes the MCPRelay program for the current user. Per-user state in
# %APPDATA%\MCPRelay (key, token, config) and logs are kept unless -RemoveState.
param(
  [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MCPRelay'),
  [switch] $RemoveState
)
$ErrorActionPreference = 'Stop'
Get-Process MCPRelay -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name MCPRelay -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'MCPRelay.lnk') -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveState) {
  Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'MCPRelay') -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'MCPRelay') -ErrorAction SilentlyContinue
}
Write-Host "MCPRelay removed$(if (-not $RemoveState) { ' (state kept in %APPDATA%\MCPRelay)' })."
