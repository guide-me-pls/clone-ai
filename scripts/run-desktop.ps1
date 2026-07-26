$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = "$cargoBin;$userPath;$env:PATH"
$target = 'x86_64-pc-windows-msvc'
. (Join-Path $PSScriptRoot 'initialize-windows-desktop-build.ps1')

Push-Location $workspace
try {
  Initialize-CloneAiDesktopBuild -Workspace $workspace
  & npm run desktop:sidecar -- --target $target
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  & (Join-Path $workspace 'node_modules\.bin\tauri.cmd') dev --config apps/desktop/src-tauri/tauri.conf.json --target $target
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
