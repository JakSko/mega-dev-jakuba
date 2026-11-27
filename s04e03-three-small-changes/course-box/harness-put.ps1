# Writes our own files into the course-tools volume, which course containers see read-only as /harness.
# The writer is a container with no network that is never started, so no code runs in it.
#   .\harness-put.ps1 -Source ..\team-harness            all files of a folder, into /harness
#   .\harness-put.ps1 -Source plan.json -Dest data/<attempt folder>/plan.json
param(
  [Parameter(Mandatory)][string]$Source,
  [string]$Dest = '',
  [string]$Tools = 'course-tools'
)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Source
if ($Dest -match '(^/|\.\.|\\|:)') { throw 'Dest is a relative path inside /harness, with / separators.' }

# docker cp needs the parent folder to exist, so the files are laid out in a new empty folder first.
$stage = Join-Path ([IO.Path]::GetTempPath()) ("harness-put-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory $stage | Out-Null
try {
  if ($item.PSIsContainer) {
    $to = if ($Dest) { Join-Path $stage $Dest } else { $stage }
    New-Item -ItemType Directory -Force $to | Out-Null
    Get-ChildItem -LiteralPath $item.FullName | Copy-Item -Destination $to -Recurse
  }
  else {
    if (-not $Dest) { throw 'A single file needs -Dest.' }
    $to = Join-Path $stage $Dest
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item -LiteralPath $item.FullName -Destination $to
  }
  docker create --name course-tools-writer --network none -v "${Tools}:/harness" course-box true | Out-Null
  if ($LASTEXITCODE) { throw 'docker create failed' }
  try {
    docker cp "$stage/." course-tools-writer:/harness
    if ($LASTEXITCODE) { throw 'docker cp failed' }
  }
  finally { docker rm course-tools-writer | Out-Null }
}
finally { Remove-Item -Recurse -Force -LiteralPath $stage -Confirm:$false }
$files = @(Get-ChildItem -LiteralPath $item.FullName -Recurse -File).Count
"OK wrote $files file(s) to $Tools" + $(if ($Dest) { " at $Dest" })
