$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Unverified([string]$Reason) {
  Write-Output "M11_NATIVE_DIALOG=UNVERIFIED: $Reason"
  if ($env:GITHUB_OUTPUT) { "result=UNVERIFIED: $Reason" | Add-Content -Encoding utf8 $env:GITHUB_OUTPUT }
  exit 0
}

if ($env:OS -ne 'Windows_NT') { Write-Unverified 'Windows is required for the native Windows dialogs.' }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $desktopWindows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
} catch { Write-Unverified "Windows UI Automation is unavailable: $($_.Exception.Message)" }
if ($desktopWindows.Count -eq 0) { Write-Unverified 'No interactive desktop window is available to automate.' }

$comScript = "try { `$app = New-Object -ComObject Illustrator.Application; if (`$app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject(`$app); exit 0 }; exit 1 } catch { exit 1 }"
$encodedComScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($comScript))
try { & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedComScript | Out-Null; $comAvailable = ($LASTEXITCODE -eq 0) } catch { $comAvailable = $false }
if ($comAvailable) { Write-Unverified 'Illustrator COM is registered, so the missing-COM warning branch does not apply.' }

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw "Electron executable is missing: $electron" }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('northstar-m11-native-dialog-' + [Guid]::NewGuid().ToString('N'))
$inputPath = Join-Path $tempRoot 'native-dialog-fixture.nbdoc'
$outputPath = Join-Path $tempRoot 'native-dialog-result.svg'
$aiPath = Join-Path $tempRoot 'native-dialog-result.ai'
$child = $null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Window([int]$TimeoutSeconds, [scriptblock]$Predicate) {
  $until = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $until) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
    foreach ($window in $windows) { if (& $Predicate $window) { return $window } }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

function Get-Descendants($Window, [System.Windows.Automation.ControlType]$Type = $null) {
  $condition = if ($null -eq $Type) { [System.Windows.Automation.Condition]::TrueCondition } else {
    New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
  }
  return $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-Control($Window, [string]$Name, [System.Windows.Automation.ControlType]$Type = $null) {
  foreach ($element in (Get-Descendants $Window $Type)) {
    if ([string]::IsNullOrEmpty($Name) -or $element.Current.Name -like "*$Name*") { return $element }
  }
  return $null
}

function Find-AnyControl($Window, [string[]]$Names, [System.Windows.Automation.ControlType]$Type) {
  foreach ($name in $Names) { $element = Find-Control $Window $name $Type; if ($element) { return $element } }
  return $null
}

function Invoke-Control($Element, [string]$Description) {
  if (-not $Element) { throw "Could not find UI control: $Description" }
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
  throw "UI control cannot be invoked: $Description"
}

function Get-MainWindow {
  return Get-Window 30 { param($window) $null -ne (Find-Control $window '내보내기' ([System.Windows.Automation.ControlType]::Button)) }
}

function Start-AiExport($Window) {
  Invoke-Control (Find-Control $Window '내보내기' ([System.Windows.Automation.ControlType]::Button)) 'export menu'
  $item = $null
  $until = [DateTime]::UtcNow.AddSeconds(5)
  while (-not $item -and [DateTime]::UtcNow -lt $until) {
    $item = Find-Control $Window 'Illustrator AI' $null
    if (-not $item) { Start-Sleep -Milliseconds 100 }
  }
  Invoke-Control $item 'Illustrator AI export menu item'
}

function Get-WarningDialog {
  return Get-Window 15 { param($window) $null -ne (Find-Control $window 'SVG로 내보내기' ([System.Windows.Automation.ControlType]::Button)) -and $null -ne (Find-Control $window '취소' ([System.Windows.Automation.ControlType]::Button)) }
}

function Get-StatusText($Window) {
  $texts = @()
  foreach ($element in (Get-Descendants $Window ([System.Windows.Automation.ControlType]::Text))) {
    if ($element.Current.Name) { $texts += $element.Current.Name }
  }
  return ($texts -join ' ')
}

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $vectorNode = [ordered]@{
    'id' = 'vector-shape'
    'name' = '벡터 경로'
    'kind' = 'path'
    'x' = 24
    'y' = 22
    'width' = 180
    'height' = 120
    'fill' = '#f97352'
    'opacity' = 100
    'rotation' = 0
    'pathSegments' = @(
      @{ op = 'M'; points = ,@(24, 178) },
      @{ op = 'L'; points = ,@(204, 178) },
      @{ op = 'L'; points = ,@(204, 58) },
      @{ op = 'L'; points = ,@(24, 58) },
      @{ op = 'Z'; points = @() }
    )
    'pathPaint' = 'f'
    'visible' = $true
    'locked' = $false
  }
  $fixture = [ordered]@{
    'format' = 'northstar-document'
    'version' = 1
    'name' = 'M11 네이티브 대화상자'
    'width' = 320
    'height' = 200
    'background' = '#ffffff'
    'groups' = @()
    'nodes' = @($vectorNode)
  }
  [IO.File]::WriteAllText($inputPath, (ConvertTo-Json -InputObject $fixture -Depth 8), $utf8NoBom)
  $inputHash = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash
  $smokeEnvironment = @{}
  foreach ($entry in (Get-ChildItem Env: | Where-Object { $_.Name -match '^NORTHSTAR_(GUI_SMOKE(?:_|$)|M9_BATCH_SMOKE$)' })) {
    $smokeEnvironment[$entry.Name] = $entry.Value
    Remove-Item -LiteralPath "Env:$($entry.Name)"
  }
  try {
    $child = Start-Process -FilePath $electron -ArgumentList @($appRoot) -WorkingDirectory $appRoot -PassThru
  } finally {
    foreach ($name in $smokeEnvironment.Keys) { Set-Item -LiteralPath "Env:$name" -Value $smokeEnvironment[$name] }
  }
  $mainWindow = Get-MainWindow
  if (-not $mainWindow) { Write-Unverified 'The editor renderer controls are not exposed to UI Automation in this desktop session.' }

  Invoke-Control (Find-Control $mainWindow '열기' ([System.Windows.Automation.ControlType]::Button)) 'open document'
  $openDialog = Get-Window 10 { param($window) $null -ne (Find-Control $window '' ([System.Windows.Automation.ControlType]::Edit)) }
  if (-not $openDialog) { throw 'Native open dialog did not appear.' }
  $fileName = Find-AnyControl $openDialog @('파일 이름', 'File name') ([System.Windows.Automation.ControlType]::Edit)
  if (-not $fileName) { $fileName = Find-Control $openDialog '' ([System.Windows.Automation.ControlType]::Edit) }
  $valuePattern = $null
  if (-not $fileName.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { throw 'Native open dialog filename field is not editable.' }
  $valuePattern.SetValue($inputPath)
  Invoke-Control (Find-AnyControl $openDialog @('열기', 'Open') ([System.Windows.Automation.ControlType]::Button)) 'open fixture file'

  $untilLoad = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $untilLoad) {
    $mainWindow = Get-MainWindow
    if ((Get-StatusText $mainWindow) -match 'M11 네이티브 대화상자') { break }
    Start-Sleep -Milliseconds 200
  }
  if ((Get-StatusText $mainWindow) -notmatch 'M11 네이티브 대화상자') { throw 'The vector fixture did not finish opening.' }
  $baselineStatus = Get-StatusText $mainWindow

  Start-AiExport $mainWindow
  $warning = Get-WarningDialog
  if (-not $warning) { throw 'Native Illustrator-unavailable warning dialog did not appear.' }
  Invoke-Control (Find-Control $warning '취소' ([System.Windows.Automation.ControlType]::Button)) 'warning Cancel'
  Start-Sleep -Milliseconds 300
  if ((Test-Path -LiteralPath $outputPath) -or (Test-Path -LiteralPath $aiPath)) { throw 'Cancel unexpectedly created an output file.' }
  if ((Get-StatusText $mainWindow) -ne $baselineStatus) { throw 'Cancel unexpectedly changed the editor success status.' }

  Start-AiExport $mainWindow
  $warning = Get-WarningDialog
  if (-not $warning) { throw 'Second native Illustrator-unavailable warning dialog did not appear.' }
  Invoke-Control (Find-Control $warning 'SVG로 내보내기' ([System.Windows.Automation.ControlType]::Button)) 'warning SVG choice'
  $saveDialog = Get-Window 15 { param($window) $null -ne (Find-Control $window '' ([System.Windows.Automation.ControlType]::Edit)) -and $null -ne (Find-AnyControl $window @('저장', 'Save') ([System.Windows.Automation.ControlType]::Button)) }
  if (-not $saveDialog) { throw 'Native SVG save dialog did not appear after selecting SVG.' }
  $saveName = Find-AnyControl $saveDialog @('파일 이름', 'File name') ([System.Windows.Automation.ControlType]::Edit)
  if (-not $saveName) { $saveName = Find-Control $saveDialog '' ([System.Windows.Automation.ControlType]::Edit) }
  $saveValue = $null
  if (-not $saveName.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$saveValue)) { throw 'Native save dialog filename field is not editable.' }
  $saveValue.SetValue($outputPath)
  Invoke-Control (Find-AnyControl $saveDialog @('저장', 'Save') ([System.Windows.Automation.ControlType]::Button)) 'save SVG file'

  $untilSave = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $outputPath) -and [DateTime]::UtcNow -lt $untilSave) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path -LiteralPath $outputPath)) { throw 'Selecting SVG did not create a file.' }
  if (Test-Path -LiteralPath $aiPath) { throw 'The SVG alternative unexpectedly created a fake .ai file.' }
  $svg = [IO.File]::ReadAllText($outputPath, [Text.Encoding]::UTF8)
  if ($svg -notmatch '<svg\b' -or $svg -notmatch '<path\b') { throw 'Saved output is missing SVG markup or vector paths.' }
  $untilStatus = [DateTime]::UtcNow.AddSeconds(10)
  do { $status = Get-StatusText $mainWindow; if ($status -match 'SVG를 내보냈습니다' -and $status.Contains([IO.Path]::GetFileName($outputPath))) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $untilStatus)
  if ($status -notmatch 'SVG를 내보냈습니다' -or -not $status.Contains([IO.Path]::GetFileName($outputPath))) { throw 'SVG success message did not identify the saved filename.' }
  if ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash -ne $inputHash) { throw 'Export unexpectedly modified the source fixture.' }
  Write-Output 'M11_NATIVE_DIALOG=PASS: Cancel created no output or success status; SVG opened the native save dialog, wrote a real SVG with vector paths, showed the matching success message, and left the source fixture unchanged.'
  if ($env:GITHUB_OUTPUT) { 'result=PASS: Cancel created no output or success status; SVG opened the native save dialog, wrote a real SVG with vector paths, showed the matching success message, and left the source fixture unchanged.' | Add-Content -Encoding utf8 $env:GITHUB_OUTPUT }
} catch {
  $failure = "FAIL: $($_.Exception.Message -replace '[\r\n]+', ' ')"
  Write-Output "M11_NATIVE_DIALOG=$failure"
  if ($env:GITHUB_OUTPUT) { "result=$failure" | Add-Content -Encoding utf8 $env:GITHUB_OUTPUT }
  throw
} finally {
  if ($child -and -not $child.HasExited) {
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    [void]$child.WaitForExit(5000)
  }
  if ($child -and -not $child.HasExited) { throw 'Editor process was not cleaned up.' }
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
  if (Test-Path -LiteralPath $tempRoot) { throw 'M11 temporary directory was not cleaned up.' }
}
