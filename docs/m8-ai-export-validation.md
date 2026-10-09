# M8 AI export GUI validation

The M8 GUI smoke is available as `npm run smoke:m8-gui` in `apps/editor` and runs from `TEST-NORTHSTAR.bat`. The M4 Windows workflow runs it once from the root launcher and records that run's JSON report and optional original SVG rendering as artifacts.

The smoke creates a synthetic 1440×960 photo document with an embedded JPEG. It checks SVG and PDF output, the unchanged source document SHA-256, embedded image/crop preservation, and removal of temporary `.tmp.ai` files and the complete per-run temp directory. These synthetic fixture results are identified as such in the output. It never sets test-only environment variables to force a choice in the Illustrator-unavailable warning. If Illustrator COM is missing, the M8 Illustrator branch is reported as `unverified` by this renderer-driven smoke.

The independent Windows GUI check is `apps/editor/scripts/m11-native-dialog-gui-smoke.ps1`. It starts the editor with inherited `NORTHSTAR_GUI_SMOKE*` test hooks removed and without any dialog-choice override, opens a vector fixture, and uses Windows UI Automation on the actual native warning and save dialogs. It selects Cancel and verifies no output file or changed success state; then selects SVG and verifies the native save dialog, a real SVG containing vector `<path>` elements, the matching success message, and an unchanged source-fixture hash. The M4 workflow runs this as a separate step. A machine without an interactive Windows desktop or Windows UI Automation reports `UNVERIFIED`; the workflow records the outcome and continues. A detected behavior failure is recorded in the step output and fails M4.

If Illustrator COM automation is available, the smoke validates the generated native Illustrator file and requires both the file and the matching GUI success status before labeling that result `PASS`. It allows the configured 120-second automation timeout plus a 10-second renderer-status grace period. If Illustrator is unavailable, actual native warning-dialog behavior is left to the independent M11 check and M8 records `UNVERIFIED`. Automation failure and timeout fail the M8 smoke. These outcomes are recorded separately from the synthetic fixture checks in the console and, when configured, a JSON result file.

The PDF fallback check inspects page bounds, trailer completeness, embedded RGB image dimensions, and decompressed canvas pixels to verify the background, edge bounds, and photo crop. The smoke also checks that the Illustrator automation temp directory and its own per-run temporary directory are removed. CI skips the launcher's interactive pause on failure so the nonzero npm result reaches the workflow promptly.

## Rendering the attached source SVG separately

The original `Untitled.svg` is optional because it may not be included in a checkout or CI job. When a copy is available, pass its path to the smoke. The real SVG is rendered in the Electron Chromium renderer and is recorded separately from the synthetic fixture. Its PNG output uses a distinct filename and is never treated as the fixture export.

```powershell
$env:NORTHSTAR_M8_SOURCE_SVG = 'C:\path\to\Untitled.svg'
$env:NORTHSTAR_M8_SOURCE_RENDER = "$env:TEMP\northstar-m8-original-svg-render.png"
$env:NORTHSTAR_M8_RESULT_FILE = "$env:TEMP\northstar-m8-ai-export-results.json"
Push-Location apps/editor
npm run smoke:m8-gui
Pop-Location
```

The Windows workflow looks for `Untitled.svg` under `temp/ProjectHub/attachments` and uploads the separate rendering and JSON report when present. If it is absent, the workflow records `SKIPPED`; the synthetic fixture still runs independently.
