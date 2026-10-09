param(
  [switch]$LaunchPackaged,
  [string]$ValidateExecutable,
  [string]$ValidatePackageDirectory,
  [string]$StatusFile
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null 2>&1
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

function Test-NorthstarExecutable {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }

  $item = Get-Item -LiteralPath $Path
  if ($item.Length -lt 1MB) { return $false }

  $stream = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $header = New-Object byte[] 64
    if ($stream.Read($header, 0, $header.Length) -lt $header.Length) { return $false }
    if ($header[0] -ne 0x4D -or $header[1] -ne 0x5A) { return $false }

    $peOffset = [BitConverter]::ToInt32($header, 0x3C)
    if ($peOffset -lt 64 -or $peOffset -gt ($stream.Length - 4)) { return $false }
    [void]$stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
    $signature = New-Object byte[] 4
    if ($stream.Read($signature, 0, 4) -ne 4) { return $false }
    return ($signature[0] -eq 0x50 -and $signature[1] -eq 0x45 -and $signature[2] -eq 0 -and $signature[3] -eq 0)
  }
  finally {
    $stream.Dispose()
  }
}

function Get-NorthstarPackageProblems {
  param([Parameter(Mandatory = $true)][string]$Directory)

  $problems = New-Object 'System.Collections.Generic.List[string]'
  $exe = Join-Path $Directory 'Northstar Editor.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $problems.Add("실행 파일 누락: `"$exe`"")
  }
  elseif (-not (Test-NorthstarExecutable -Path $exe)) {
    $problems.Add("실행 파일이 손상되었거나 유효한 PE 파일이 아닙니다: `"$exe`"")
  }

  $requiredFiles = @(
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'd3dcompiler_47.dll',
    'ffmpeg.dll',
    'icudtl.dat',
    'libEGL.dll',
    'libGLESv2.dll',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'locales\en-US.pak',
    'resources\app.asar'
  )
  foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $Directory $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      $problems.Add("패키지 파일 누락: `"$path`"")
    }
    elseif ((Get-Item -LiteralPath $path).Length -le 0) {
      $problems.Add("패키지 파일이 비어 있습니다: `"$path`"")
    }
  }

  return $problems.ToArray()
}

function Set-LaunchStatus {
  param([Parameter(Mandatory = $true)][string]$Status)
  if ($StatusFile) {
    [System.IO.File]::WriteAllText($StatusFile, $Status, [System.Text.Encoding]::ASCII)
  }
}

function Expand-NorthstarZipSafely {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  $stage = Join-Path (Split-Path -Parent $Destination) ('.northstar-stage-' + [Guid]::NewGuid().ToString('N'))
  $backup = Join-Path (Split-Path -Parent $Destination) ('.northstar-backup-' + [Guid]::NewGuid().ToString('N'))
  $destinationMoved = $false

  try {
    if ($archive.Entries.Count -gt 20000) { throw 'ZIP 항목 수가 안전 한도를 초과했습니다.' }
    [void](New-Item -ItemType Directory -Path $stage)
    $stagePrefix = [System.IO.Path]::GetFullPath($stage).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName.Replace('/', '\')
      if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|\\)\.\.(\\|$)') {
        throw "ZIP에 안전하지 않은 경로가 있습니다: $($entry.FullName)"
      }

      $target = [System.IO.Path]::GetFullPath((Join-Path $stage $relative))
      if (-not $target.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "ZIP 경로가 추출 폴더 밖을 가리킵니다: $($entry.FullName)"
      }

      if ($entry.FullName.EndsWith('/')) {
        [void](New-Item -ItemType Directory -Path $target -Force)
        continue
      }

      $parent = Split-Path -Parent $target
      [void](New-Item -ItemType Directory -Path $parent -Force)
      $inputStream = $entry.Open()
      try {
        $outputStream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) }
        finally { $outputStream.Dispose() }
      }
      finally { $inputStream.Dispose() }
    }

    $stageProblems = @(Get-NorthstarPackageProblems -Directory $stage)
    if ($stageProblems.Count -gt 0) {
      throw "ZIP에서 완전한 Electron 패키지를 찾지 못했습니다: $($stageProblems -join '; ')"
    }

    if (Test-Path -LiteralPath $Destination) {
      Move-Item -LiteralPath $Destination -Destination $backup
      $destinationMoved = $true
    }
    Move-Item -LiteralPath $stage -Destination $Destination
    if ($destinationMoved) { Remove-Item -LiteralPath $backup -Recurse -Force }
  }
  catch {
    if ($destinationMoved -and -not (Test-Path -LiteralPath $Destination) -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $Destination
    }
    throw
  }
  finally {
    $archive.Dispose()
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}

if ($ValidateExecutable) {
  if (-not (Test-NorthstarExecutable -Path $ValidateExecutable)) {
    [Console]::Error.WriteLine("[오류] 유효한 Windows 실행 파일이 아닙니다: `"$ValidateExecutable`"")
    exit 1
  }
  Write-Output "실행 파일 확인 완료: $ValidateExecutable"
  exit 0
}

if ($ValidatePackageDirectory) {
  $packageProblems = @(Get-NorthstarPackageProblems -Directory $ValidatePackageDirectory)
  if ($packageProblems.Count -gt 0) {
    foreach ($problem in $packageProblems) { [Console]::Error.WriteLine("[오류] $problem") }
    exit 1
  }
  Write-Output "Electron 패키지 확인 완료: $ValidatePackageDirectory"
  exit 0
}

if (-not $LaunchPackaged) {
  [Console]::Error.WriteLine('사용법: -LaunchPackaged, -ValidateExecutable 경로 또는 -ValidatePackageDirectory 폴더')
  exit 1
}

$projectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$release = Join-Path $projectRoot 'apps\editor\release'
$unpacked = Join-Path $release 'win-unpacked'
$exe = Join-Path $unpacked 'Northstar Editor.exe'

try {
  $packageProblems = @(Get-NorthstarPackageProblems -Directory $unpacked)
  if ($packageProblems.Count -gt 0) {
    foreach ($problem in $packageProblems) { Write-Host "[안내] $problem" }

    $zip = Get-ChildItem -LiteralPath $release -File -Filter 'Northstar-Editor-*-win-x64.zip' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $zip) {
      Write-Host '[안내] 사용할 수 있는 win-unpacked 실행 파일이나 기존 Windows ZIP 패키지가 없습니다.'
      Set-LaunchStatus -Status 'fallback'
      exit 2
    }

    Write-Host "[안내] 기존 ZIP 패키지를 안전하게 확인하고 추출합니다: `"$($zip.FullName)`""
    Expand-NorthstarZipSafely -ArchivePath $zip.FullName -Destination $unpacked
    $exe = Join-Path $unpacked 'Northstar Editor.exe'
  }

  $packageProblems = @(Get-NorthstarPackageProblems -Directory $unpacked)
  if ($packageProblems.Count -gt 0) {
    foreach ($problem in $packageProblems) { Write-Host "[오류] $problem" }
    Write-Host "[오류] ZIP 추출 후에도 Electron 실행 패키지가 완전하지 않습니다: `"$unpacked`""
    Set-LaunchStatus -Status 'fallback'
    exit 2
  }

  Write-Host "Northstar Editor를 실행합니다: `"$exe`""
  Set-LaunchStatus -Status 'launched'
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $exe
  $startInfo.WorkingDirectory = $unpacked
  $startInfo.UseShellExecute = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw 'Windows에서 앱 프로세스를 시작하지 못했습니다.' }
  $process.WaitForExit()
  exit $process.ExitCode
}
catch {
  [Console]::Error.WriteLine("[오류] 패키지 확인·추출·실행에 실패했습니다: $($_.Exception.Message)")
  [Console]::Error.WriteLine('[안내] 개발 실행 경로로 전환합니다. ZIP 손상 여부와 폴더 쓰기 권한을 확인하세요.')
  Set-LaunchStatus -Status 'fallback'
  exit 2
}
