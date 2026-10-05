# Builds the self-contained Windows node package into <OutDir>:
#   MCPRelay.exe            tray app / supervisor (compiled with the .NET Framework csc in Windows)
#   runtime\node\node.exe   pinned Node.js (SHA-256 verified)
#   runtime\app\            server.mjs, git.mjs + production node_modules (npm ci from the lockfile)
#                           + mcprelay-proc.exe, the process helper (ADR-0008)
#   install.ps1, uninstall.ps1
#
#   powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1 [-OutDir dist\MCPRelay]
param([string] $OutDir = "dist\MCPRelay")
$ErrorActionPreference = 'Stop'

$NodeVersion = 'v24.21.0'
$NodeZipSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not [IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $repo $OutDir }
# Empty (not delete) the output dir: a shell or Explorer window may hold it open.
if (Test-Path $OutDir) { Get-ChildItem -Force $OutDir | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force "$OutDir\runtime\node", "$OutDir\runtime\app" | Out-Null

Write-Host "== compile MCPRelay.exe"
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ "/out:$OutDir\MCPRelay.exe" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
  (Join-Path $repo 'app\windows\MCPRelay.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed" }

Write-Host "== compile mcprelay-proc.exe (process helper)"
& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$OutDir\runtime\app\mcprelay-proc.exe" `
  /r:System.Web.Extensions.dll (Join-Path $repo 'app\windows\mcprelay-proc.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed (mcprelay-proc)" }

Write-Host "== Node.js $NodeVersion"
$cache = Join-Path $env:LOCALAPPDATA 'MCPRelay-build-cache'
New-Item -ItemType Directory -Force $cache | Out-Null
$zipName = "node-$NodeVersion-win-x64.zip"
$zip = Join-Path $cache $zipName
if (-not (Test-Path $zip)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile $zip
}
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($hash -ne $NodeZipSha256) { Remove-Item $zip; throw "Node.js zip checksum mismatch: $hash" }
$tmp = Join-Path $cache "node-extract"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive $zip $tmp
$nodeDir = Join-Path $tmp "node-$NodeVersion-win-x64"
Copy-Item "$nodeDir\node.exe", "$nodeDir\LICENSE" "$OutDir\runtime\node\"
Remove-Item -Recurse -Force $tmp

Write-Host "== capability server + production dependencies (npm ci)"
foreach ($f in 'server.mjs', 'git.mjs', 'package.json', 'package-lock.json') {
  Copy-Item (Join-Path $repo "node-runtime\$f") "$OutDir\runtime\app\"
}
Push-Location "$OutDir\runtime\app"
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
} finally { Pop-Location }

Copy-Item (Join-Path $PSScriptRoot 'install.ps1'), (Join-Path $PSScriptRoot 'uninstall.ps1') $OutDir
$commit = (& git -C $repo rev-parse --short HEAD) 2>$null
@"
MCPRelay node package
built:   $(Get-Date -Format s)
commit:  $commit
node:    $NodeVersion
server:  $((Select-String -Path (Join-Path $repo 'node-runtime\server.mjs') -Pattern "const VERSION = '([^']+)'").Matches[0].Groups[1].Value)
"@ | Set-Content -Encoding UTF8 "$OutDir\VERSION.txt"

$size = (Get-ChildItem -Recurse $OutDir | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("== done: {0} ({1:N0} MiB)" -f $OutDir, $size)
