# The owner runs this in their own terminal. It starts course-gate with the real key and the limits for one run.
# The key stays in this process and in the gate container until the gate is removed (docker rm -f course-gate).
#   .\gate-up.ps1 -Model gpt-6.2-sol -MaxRequests 4
param(
  [Parameter(Mandatory)][string]$Model,
  [Parameter(Mandatory)][ValidateRange(1, 500)][int]$MaxRequests,
  [ValidateRange(1, 32000)][int]$MaxOutputTokens = 4000,
  [string]$Hosts = ''
)
$ErrorActionPreference = 'Stop'

if (docker ps -a --filter 'name=^course-gate$' --format '{{.Names}}') {
  throw 'course-gate already exists. Remove it first: docker rm -f course-gate'
}

$typed = -not $env:OPENAI_API_KEY
try {
  if ($typed) { $env:OPENAI_API_KEY = Read-Host 'OpenAI API key (hidden)' -MaskInput }
  if (-not $env:OPENAI_API_KEY) { throw 'No key.' }
  docker create --name course-gate --network course-out --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --memory 256m --pids-limit 64 -v course-gate-code:/gate:ro -e OPENAI_API_KEY -e "GATE_MODELS=$Model" -e "GATE_MAX_REQUESTS=$MaxRequests" -e "GATE_MAX_OUTPUT_TOKENS=$MaxOutputTokens" -e "GATE_HOSTS=$Hosts" course-box node /gate/gate.mjs | Out-Null
  if ($LASTEXITCODE) { throw 'docker create failed' }
}
finally {
  # A key typed here does not stay in this terminal.
  if ($typed) { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }
}
docker network connect course-in course-gate
if ($LASTEXITCODE) { throw 'docker network connect failed' }
docker start course-gate | Out-Null
if ($LASTEXITCODE) { throw 'docker start failed' }
Start-Sleep -Seconds 2
docker logs course-gate
docker ps --filter 'name=^course-gate$' --format '{{.Names}} {{.Status}}'
