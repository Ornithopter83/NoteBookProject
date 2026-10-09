param(
  [string]$WorkDirectory
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null 2>&1
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if ($env:OS -ne 'Windows_NT') { throw 'M7 launcher E2E requires Windows.' }
if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'M7 launcher E2E requires Windows PowerShell 5.1 or newer.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$sourceLauncher = Join-Path $repoRoot 'RUN-NORTHSTAR.bat'
$sourceHelper = Join-Path $PSScriptRoot 'm7-launch-check.ps1'
if (-not $WorkDirectory) {
  $WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('Northstar M7 E2E ' + [Guid]::NewGuid().ToString('N'))
}
$workRoot = [System.IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $workRoot) { throw "E2E work directory already exists: $workRoot" }
[void](New-Item -ItemType Directory -Path $workRoot -Force)

$passed = 0
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "E2E 실패: $Message" }
  $script:passed++
  Write-Host "[통과] $Message"
}

function New-FixtureRoot {
  param([string]$Name)
  $root = Join-Path $workRoot $Name
  [void](New-Item -ItemType Directory -Path (Join-Path $root 'apps\editor\scripts') -Force)
  [void](New-Item -ItemType Directory -Path (Join-Path $root 'packages\psd-bridge') -Force)
  Copy-Item -LiteralPath $sourceLauncher -Destination (Join-Path $root 'RUN-NORTHSTAR.bat')
  Copy-Item -LiteralPath $sourceHelper -Destination (Join-Path $root 'apps\editor\scripts\m7-launch-check.ps1')
  return $root
}

function New-PackageDirectory {
  param([string]$Directory, [string]$Executable, [switch]$Complete)
  [void](New-Item -ItemType Directory -Path $Directory -Force)
  if ($Executable) { Copy-Item -LiteralPath $Executable -Destination (Join-Path $Directory 'Northstar Editor.exe') -Force }
  if ($Complete) {
    foreach ($name in @('chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','ffmpeg.dll','icudtl.dat','libEGL.dll','libGLESv2.dll','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin')) {
      [System.IO.File]::WriteAllBytes((Join-Path $Directory $name), [byte[]](1,2,3,4))
    }
    [void](New-Item -ItemType Directory -Path (Join-Path $Directory 'locales') -Force)
    [void](New-Item -ItemType Directory -Path (Join-Path $Directory 'resources') -Force)
    [System.IO.File]::WriteAllBytes((Join-Path $Directory 'locales\en-US.pak'), [byte[]](1,2,3,4))
    [System.IO.File]::WriteAllBytes((Join-Path $Directory 'resources\app.asar'), [byte[]](1,2,3,4))
  }
}

function New-PackageZip {
  param([string]$PackageDirectory, [string]$ReleaseDirectory)
  [void](New-Item -ItemType Directory -Path $ReleaseDirectory -Force)
  $zipPath = Join-Path $ReleaseDirectory 'Northstar-Editor-e2e-win-x64.zip'
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($PackageDirectory, $zipPath)
  return $zipPath
}

function Invoke-Helper {
  param([string]$Root, [string[]]$ExtraArguments)
  $helper = Join-Path $Root 'apps\editor\scripts\m7-launch-check.ps1'
  $status = Join-Path $Root 'launch.status'
  $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $helper + '" -LaunchPackaged -ProjectRoot "' + $Root + '" -StatusFile "' + $status + '"'
  foreach ($extra in $ExtraArguments) { $arguments += ' -' + $extra.TrimStart('-') }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = $arguments
  $info.WorkingDirectory = $Root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Status = if (Test-Path -LiteralPath $status) { [System.IO.File]::ReadAllText($status, [System.Text.Encoding]::ASCII).Trim() } else { '' }; Output = $stdoutTask.Result; Error = $stderrTask.Result }
}

function Invoke-Batch {
  param([string]$Root)
  $batch = Join-Path $Root 'RUN-NORTHSTAR.bat'
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:WINDIR 'System32\cmd.exe'
  $info.Arguments = '/d /c ""' + $batch + '""'
  $info.WorkingDirectory = $Root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Close()
  $process.WaitForExit()
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdoutTask.Result; Error = $stderrTask.Result }
}

try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $sourceDirectory = Join-Path $workRoot 'gui-fixture-source'
  [void](New-Item -ItemType Directory -Path $sourceDirectory -Force)
  $fixtureSource = @'
using System;
using System.IO;
using System.Windows.Forms;
public static class NorthstarE2EGui {
  [STAThread]
  public static int Main() {
    string marker = Environment.GetEnvironmentVariable("NORTHSTAR_E2E_GUI_MARKER");
    string exitText = Environment.GetEnvironmentVariable("NORTHSTAR_E2E_GUI_EXIT");
    int exitCode = 0;
    Int32.TryParse(exitText, out exitCode);
    Application.EnableVisualStyles();
    Form form = new Form();
    form.Text = "Northstar E2E GUI";
    form.Width = 420;
    form.Height = 180;
    Label label = new Label();
    label.Text = "Northstar packaged GUI fixture";
    label.Dock = DockStyle.Fill;
    label.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
    form.Controls.Add(label);
    form.Shown += delegate { if (!String.IsNullOrEmpty(marker)) File.WriteAllText(marker, "gui-started"); };
    Timer timer = new Timer();
    timer.Interval = 500;
    timer.Tick += delegate { timer.Stop(); form.Close(); };
    timer.Start();
    Application.Run(form);
    return exitCode;
  }
}
'@
  $sourceFile = Join-Path $sourceDirectory 'NorthstarE2EGui.cs'
  $fixtureExe = Join-Path $sourceDirectory 'Northstar Editor.exe'
  [System.IO.File]::WriteAllText($sourceFile, $fixtureSource, (New-Object System.Text.UTF8Encoding($false)))
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler was not found.' }
  & $compiler /nologo /target:winexe (('/out:' + $fixtureExe)) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $sourceFile
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the temporary GUI fixture.' }
  $exeStream = [System.IO.File]::Open($fixtureExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $exeStream.SetLength(1MB + 4096) } finally { $exeStream.Dispose() }

  # Verify the shortcut target failure mode without opening a shell error dialog.
  $shortcutRoot = New-FixtureRoot 'bad shortcut target'
  $wrongLinkPath = Join-Path $shortcutRoot 'Northstar wrong shortcut.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $wrongLink = $shell.CreateShortcut($wrongLinkPath)
  $wrongLink.TargetPath = Join-Path $shortcutRoot 'RUN-NORTHSTAR.bat.missing'
  $wrongLink.WorkingDirectory = $shortcutRoot
  $wrongLink.Save()
  $wrongLinkRead = $shell.CreateShortcut($wrongLinkPath)
  $wrongTargetExists = Test-Path -LiteralPath $wrongLinkRead.TargetPath
  $wrongTargetIsLauncher = $wrongLinkRead.TargetPath -eq (Join-Path $shortcutRoot 'RUN-NORTHSTAR.bat')
  Assert-True ((-not $wrongTargetExists) -and (-not $wrongTargetIsLauncher)) '잘못된 바로가기 대상이 존재하지 않고 배치 파일과 다름을 탐지'

  $batchRoot = New-FixtureRoot 'space path batch launch'
  $package = Join-Path $batchRoot 'apps\editor\release\win-unpacked'
  New-PackageDirectory -Directory $package -Executable $fixtureExe -Complete
  $correctLinkPath = Join-Path $batchRoot 'Northstar correct shortcut.lnk'
  $correctLink = $shell.CreateShortcut($correctLinkPath)
  $correctLink.TargetPath = Join-Path $batchRoot 'RUN-NORTHSTAR.bat'
  $correctLink.WorkingDirectory = $batchRoot
  $correctLink.Save()
  $correctLinkRead = $shell.CreateShortcut($correctLinkPath)
  Assert-True ($correctLinkRead.TargetPath -eq (Join-Path $batchRoot 'RUN-NORTHSTAR.bat') -and (Test-Path -LiteralPath $correctLinkRead.TargetPath)) '올바른 바로가기가 공백 경로의 실제 배치 파일을 대상으로 지정'
  $env:NORTHSTAR_E2E_GUI_MARKER = Join-Path $batchRoot 'gui.started'
  $env:NORTHSTAR_E2E_GUI_EXIT = '0'
  $launchResult = Invoke-Batch -Root $batchRoot
  Assert-True ($launchResult.ExitCode -eq 0 -and (Test-Path -LiteralPath $env:NORTHSTAR_E2E_GUI_MARKER)) '공백 경로의 실제 배치 파일이 GUI를 실행하고 정상 종료'

  $exitRoot = New-FixtureRoot 'exit code propagation'
  $exitPackage = Join-Path $exitRoot 'apps\editor\release\win-unpacked'
  New-PackageDirectory -Directory $exitPackage -Executable $fixtureExe -Complete
  $env:NORTHSTAR_E2E_GUI_MARKER = Join-Path $exitRoot 'gui.started'
  $env:NORTHSTAR_E2E_GUI_EXIT = '23'
  $batchResult = Invoke-Batch -Root $exitRoot
  Assert-True ($batchResult.ExitCode -eq 23 -and (Test-Path -LiteralPath $env:NORTHSTAR_E2E_GUI_MARKER)) '실제 배치 파일이 GUI 종료 코드 23을 호출자에게 전달'

  $zipRoot = New-FixtureRoot 'zip restoration'
  $zipSource = Join-Path $zipRoot 'zip-source'
  New-PackageDirectory -Directory $zipSource -Executable $fixtureExe -Complete
  [void](New-PackageZip -PackageDirectory $zipSource -ReleaseDirectory (Join-Path $zipRoot 'apps\editor\release'))
  $env:NORTHSTAR_E2E_GUI_MARKER = Join-Path $zipRoot 'gui.started'
  $env:NORTHSTAR_E2E_GUI_EXIT = '0'
  $zipResult = Invoke-Helper -Root $zipRoot -ExtraArguments @()
  Assert-True ($zipResult.ExitCode -eq 0 -and $zipResult.Status -eq 'launched' -and (Test-Path -LiteralPath (Join-Path $zipRoot 'apps\editor\release\win-unpacked\Northstar Editor.exe'))) 'exe 누락 시 ZIP을 복구하고 GUI 실행'

  $incompleteRoot = New-FixtureRoot 'incomplete package'
  $incompleteSource = Join-Path $incompleteRoot 'incomplete-source'
  New-PackageDirectory -Directory $incompleteSource -Complete
  [void](New-PackageZip -PackageDirectory $incompleteSource -ReleaseDirectory (Join-Path $incompleteRoot 'apps\editor\release'))
  $incompleteResult = Invoke-Helper -Root $incompleteRoot -ExtraArguments @()
  Assert-True ($incompleteResult.ExitCode -eq 2 -and $incompleteResult.Status -eq 'fallback') '불완전한 ZIP 패키지에서 안전한 개발 경로 전환 상태 반환'

  $failureRoot = New-FixtureRoot 'corrupt archive'
  $failureRelease = Join-Path $failureRoot 'apps\editor\release'
  [void](New-Item -ItemType Directory -Path $failureRelease -Force)
  [System.IO.File]::WriteAllText((Join-Path $failureRelease 'Northstar-Editor-broken-win-x64.zip'), 'not a zip', (New-Object System.Text.UTF8Encoding($false)))
  $failureResult = Invoke-Helper -Root $failureRoot -ExtraArguments @()
  Assert-True ($failureResult.ExitCode -eq 2 -and $failureResult.Status -eq 'fallback') '손상된 ZIP 복구 실패 시 개발 경로 전환 상태 반환'

  $rollbackRoot = New-FixtureRoot 'rollback recovery'
  $rollbackRelease = Join-Path $rollbackRoot 'apps\editor\release'
  $rollbackDestination = Join-Path $rollbackRelease 'win-unpacked'
  New-PackageDirectory -Directory $rollbackDestination -Executable $fixtureExe -Complete
  Remove-Item -LiteralPath (Join-Path $rollbackDestination 'Northstar Editor.exe') -Force
  $oldMarker = Join-Path $rollbackDestination 'previous-package.marker'
  [System.IO.File]::WriteAllText($oldMarker, 'preserve-me', (New-Object System.Text.UTF8Encoding($false)))
  $rollbackSource = Join-Path $rollbackRoot 'new-package'
  New-PackageDirectory -Directory $rollbackSource -Executable $fixtureExe -Complete
  [void](New-PackageZip -PackageDirectory $rollbackSource -ReleaseDirectory $rollbackRelease)
  $rollbackResult = Invoke-Helper -Root $rollbackRoot -ExtraArguments @('-TestFailAfterBackup')
  Assert-True ($rollbackResult.ExitCode -eq 2 -and $rollbackResult.Status -eq 'fallback' -and (Test-Path -LiteralPath $oldMarker) -and (Get-Content -LiteralPath $oldMarker -Encoding UTF8 -Raw) -eq 'preserve-me') 'ZIP 반영 실패 시 기존 패키지를 rollback으로 보존'

  $fallbackRoot = New-FixtureRoot 'development fallback'
  $stubBin = Join-Path $fallbackRoot 'command stubs'
  [void](New-Item -ItemType Directory -Path $stubBin -Force)
  $stubBatch = '@echo off' + [Environment]::NewLine + 'exit /b 0' + [Environment]::NewLine
  [System.IO.File]::WriteAllText((Join-Path $stubBin 'node.bat'), $stubBatch, (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText((Join-Path $stubBin 'npm.bat'), $stubBatch, (New-Object System.Text.UTF8Encoding($false)))
  $oldPath = $env:PATH
  $env:PATH = [string]::Concat($stubBin, [char]59, $oldPath)
  try { $fallbackBatch = Invoke-Batch -Root $fallbackRoot } finally { $env:PATH = $oldPath }
  if ($fallbackBatch.ExitCode -ne 0) { throw "Development fallback E2E failed." }
  $passed++
  Write-Host '[통과] 패키지 실행 불가 시 개발 실행으로 전환'

  Write-Output $passed
}
catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  throw
}
finally {
  Remove-Item Env:NORTHSTAR_E2E_GUI_MARKER -ErrorAction SilentlyContinue
  Remove-Item Env:NORTHSTAR_E2E_GUI_EXIT -ErrorAction SilentlyContinue
  if ($workRoot -and (Test-Path -LiteralPath $workRoot)) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
}
