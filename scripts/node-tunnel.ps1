# MCPRelay node reverse tunnel (M2), Windows. Keeps an OpenSSH reverse forward
# from VPS loopback <RemotePort> to the local bridge, restarting on failure.
#
#   powershell -File scripts\node-tunnel.ps1 -VpsHost <vps-host> -RemotePort 18101 `
#       -KeyFile $env:USERPROFILE\.ssh\mcprelay_node -KnownHosts $env:USERPROFILE\.ssh\mcprelay_known_hosts
param(
  [Parameter(Mandatory)] [string] $VpsHost,
  [Parameter(Mandatory)] [int] $RemotePort,
  [Parameter(Mandatory)] [string] $KeyFile,
  [Parameter(Mandatory)] [string] $KnownHosts,
  [int] $LocalPort = 18001,
  [string] $User = 'mcptunnel'
)

$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$delays = 1, 2, 5, 10, 30
$attempt = 0
while ($true) {
  $started = Get-Date
  Write-Host "$(Get-Date -Format s) [tunnel] connecting $User@$VpsHost (-R 127.0.0.1:${RemotePort} -> 127.0.0.1:${LocalPort})"
  & $ssh -N -T `
    -i $KeyFile `
    -o IdentitiesOnly=yes `
    -o BatchMode=yes `
    -o StrictHostKeyChecking=yes `
    -o UserKnownHostsFile=$KnownHosts `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=15 `
    -o ServerAliveCountMax=3 `
    -o ConnectTimeout=15 `
    -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" `
    "$User@$VpsHost"
  $code = $LASTEXITCODE
  # A connection that lived for a while resets the backoff.
  if (((Get-Date) - $started).TotalSeconds -gt 60) { $attempt = 0 }
  $delay = $delays[[Math]::Min($attempt, $delays.Count - 1)]
  $attempt++
  Write-Host "$(Get-Date -Format s) [tunnel] ssh exited ($code); retry in ${delay}s"
  Start-Sleep -Seconds $delay
}
