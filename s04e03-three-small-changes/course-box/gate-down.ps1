# The only way we remove course-gate: its log is saved first. If the log cannot be saved, the gate stays.
#   .\gate-down.ps1 -LogDir <folder>
param([Parameter(Mandatory)][string]$LogDir)
$ErrorActionPreference = 'Stop'
if (-not (docker ps -a --filter 'name=^course-gate$' --format '{{.Names}}')) { throw 'There is no course-gate.' }
New-Item -ItemType Directory -Force $LogDir | Out-Null
$file = Join-Path (Resolve-Path $LogDir) ("gate-" + (Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss') + "Z.log")
$log = docker logs course-gate 2>&1
if ($LASTEXITCODE) { throw 'docker logs failed: the gate is not removed' }
$log | Out-File -LiteralPath $file -Encoding utf8
if (-not (Test-Path -LiteralPath $file)) { throw 'the log was not written: the gate is not removed' }
docker rm -f course-gate | Out-Null
if ($LASTEXITCODE) { throw 'docker rm failed' }
"OK gate removed; log: $file ($(@($log).Count) lines)"
