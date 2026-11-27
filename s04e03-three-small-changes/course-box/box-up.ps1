# Starts the container that runs course code. No real key ever goes into it.
#   .\box-up.ps1                 offline: container course-box, no network (reading, tests)
#   .\box-up.ps1 -Mode gate      run: container course-run on course-in only, the way out is course-gate
# /harness is our tools and checks (volume course-tools, filled with harness-put.ps1), always mounted read-only.
# The settings are checked after the start. If one is wrong, a container made by this run is removed.
# Stop: docker stop course-box. After a run: docker rm -f course-run.
param(
  [ValidateSet('offline', 'gate')][string]$Mode = 'offline',
  [string]$Volume = 'course-work',
  [string]$Tools = 'course-tools',
  [string]$Name = ''
)
$ErrorActionPreference = 'Stop'

if (-not $Name) { $Name = if ($Mode -eq 'gate') { 'course-run' } else { 'course-box' } }
$network = if ($Mode -eq 'gate') { 'course-in' } else { 'none' }
$exists = [bool](docker ps -a --filter "name=^$Name$" --format '{{.Names}}')
if ($LASTEXITCODE) { throw 'Docker does not answer. Is Docker Desktop running?' }

if ($Mode -eq 'gate') {
  if ($exists) { throw "$Name already exists. A run gets a new container: docker rm -f $Name" }
  if ((docker ps --filter 'name=^course-gate$' --format '{{.Names}}') -ne 'course-gate') {
    throw 'course-gate is not running. The owner starts it with gate-up.ps1 in their own terminal.'
  }
  $internal = docker network inspect course-in --format '{{.Internal}}'
  if ($internal -ne 'true') { throw 'course-in is missing or not internal.' }
}

if (-not $exists) {
  $run = @('run', '-d', '--name', $Name, '--network', $network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/course:uid=10001', '-v', "${Volume}:/work", '-v', "${Tools}:/harness:ro", '--memory', '2g', '--pids-limit', '256')
  if ($Mode -eq 'gate') {
    # Literal values only. A bare "-e OPENAI_API_KEY" would copy the real key from this terminal.
    $run += @('-e', 'OPENAI_API_KEY=dummy-not-a-key', '-e', 'HTTPS_PROXY=http://course-gate:8080',
      '-e', 'NO_PROXY=127.0.0.1,localhost,course-gate', '-e', 'NODE_USE_ENV_PROXY=1')
  }
  docker @run course-box | Out-Null
  if ($LASTEXITCODE) { throw 'docker run failed' }
}

# Check what really exists, also for a container made earlier.
$c = (docker inspect $Name | ConvertFrom-Json)[0]
$wrong = @()
$mounts = @($c.Mounts)
$work = @($mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq $Volume -and $_.Destination -eq '/work' })
$harness = @($mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq $Tools -and $_.Destination -eq '/harness' -and -not $_.RW })
if ($mounts.Count -ne 2 -or $work.Count -ne 1 -or $harness.Count -ne 1) { $wrong += 'mounts' }
if ($c.HostConfig.Privileged) { $wrong += 'privileged' }
if (-not $c.HostConfig.ReadonlyRootfs) { $wrong += 'root file system is writable' }
if (@($c.HostConfig.CapDrop) -notcontains 'ALL' -or @($c.HostConfig.CapAdd).Where({ $_ }).Count) { $wrong += 'capabilities' }
if (@($c.HostConfig.SecurityOpt) -notcontains 'no-new-privileges') { $wrong += 'no-new-privileges' }
if (@($c.HostConfig.PortBindings.PSObject.Properties).Count) { $wrong += 'published ports' }
if ($c.Config.User -ne 'course') { $wrong += 'user' }
$nets = @($c.NetworkSettings.Networks.PSObject.Properties.Name) -join ','
if ($nets -ne $network) { $wrong += "networks: $nets" }
$keys = @($c.Config.Env | Where-Object { $_ -match '^[^=]*(KEY|TOKEN|SECRET|PASSWORD)[^=]*=' -and $_ -ne 'OPENAI_API_KEY=dummy-not-a-key' })
if ($keys.Count) { $wrong += 'a key-like variable: ' + (($keys | ForEach-Object { $_.Split('=')[0] }) -join ',') }

if ($wrong.Count) {
  if (-not $exists) { docker rm -f $Name | Out-Null }
  throw "$Name does not match the rules ($($wrong -join '; ')). Do not run course code in it."
}

if (-not $c.State.Running) {
  docker start $Name | Out-Null
  if ($LASTEXITCODE) { throw 'docker start failed' }
}

if ($Mode -eq 'gate') {
  # /home/course is in memory, so Pi's model address is written at every start.
  '{"providers":{"openai":{"baseUrl":"http://course-gate:8081/v1"}}}' |
    docker exec -i $Name sh -c 'mkdir -p /home/course/.pi/agent && cat > /home/course/.pi/agent/models.json'
  if ($LASTEXITCODE) { throw 'writing models.json failed' }
}

"OK $Name mode=$Mode network=$network volume=$Volume harness=$Tools(ro)"
