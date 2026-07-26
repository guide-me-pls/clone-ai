function Initialize-CloneAiDesktopBuild {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace
  )

  $vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw 'Visual Studio Build Tools are required to create the Windows desktop client.'
  }

  $environmentLines = & cmd.exe /d /c "call `"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  foreach ($line in $environmentLines) {
    if ($line -match '^(?<name>[^=]+)=(?<value>.*)$' -and -not $matches.name.StartsWith('=')) {
      Set-Item -Path "Env:$($matches.name)" -Value $matches.value
    }
  }

  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Lib'
  $sdkVersionDirectory = Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\x64') } |
    Select-Object -First 1

  if (-not $sdkVersionDirectory) {
    throw 'A Windows SDK is required to create the Windows desktop client.'
  }

  $sdkLibrary = Join-Path $sdkVersionDirectory.FullName 'um\x64'
  $sdkIncludeRoot = Join-Path (Join-Path (Split-Path $sdkRoot -Parent) 'Include') $sdkVersionDirectory.Name
  $sdkIncludes = @('um', 'shared', 'ucrt', 'winrt', 'cppwinrt') |
    ForEach-Object { Join-Path $sdkIncludeRoot $_ } |
    Where-Object { Test-Path -LiteralPath $_ }
  if ($sdkIncludes.Count -eq 0) {
    throw 'The installed Windows SDK is missing its C/C++ header files.'
  }

  $shimDirectory = Join-Path $Workspace 'apps\desktop\.build\windows-sdk-shims'
  New-Item -ItemType Directory -Force -Path $shimDirectory | Out-Null
  $requiredSystemLibraries = @('advapi32', 'dbghelp', 'kernel32', 'ntdll', 'ole32', 'shell32', 'userenv', 'ws2_32')
  foreach ($libraryName in $requiredSystemLibraries) {
    if (Test-Path -LiteralPath (Join-Path $sdkLibrary "$libraryName.lib")) {
      continue
    }

    $systemDll = Join-Path $env:SystemRoot "System32\$libraryName.dll"
    if (-not (Test-Path -LiteralPath $systemDll)) {
      throw "The Windows system library is unavailable: $libraryName.dll."
    }

    $exports = & link.exe /dump /exports $systemDll |
      ForEach-Object {
        if ($_ -match '^\s*\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(?<name>\S+)$') {
          $matches.name
        }
      }
    if ($exports.Count -eq 0) {
      throw "Unable to inspect exports for $libraryName.dll."
    }

    $shimDefinition = Join-Path $shimDirectory "$libraryName.def"
    [System.IO.File]::WriteAllLines($shimDefinition, @("LIBRARY $libraryName.dll", 'EXPORTS') + $exports)
    $shimLibrary = Join-Path $shimDirectory "$libraryName.lib"
    & lib.exe /nologo "/def:$shimDefinition" /machine:x64 "/out:$shimLibrary"
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to prepare the local Windows SDK compatibility library: $libraryName.lib."
    }
  }

  $env:INCLUDE = "$($sdkIncludes -join ';');$env:INCLUDE"
  $env:LIB = "$shimDirectory;$sdkLibrary;$env:LIB"
}
