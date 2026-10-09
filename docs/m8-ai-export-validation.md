# M8 AI export GUI validation

The M8 GUI smoke is available as `npm run smoke:m8-gui` in `apps/editor` and runs from `TEST-NORTHSTAR.bat`. The M4 Windows workflow runs it once from the root launcher and records that run's JSON report and optional original SVG rendering as artifacts.

The smoke creates a synthetic 1440×960 photo document with an embedded JPEG. When Illustrator COM is unavailable, the smoke sets test-only environment variables to select Cancel on the first AI export and SVG on the second. It verifies that Cancel creates no file or success state, the SVG alternative creates a real file whose basename appears in the success state, and no fake `.ai` is created. These automated selections exercise the test branch; they do not verify that a person can select buttons in the native warning dialog. The smoke also checks SVG and PDF output, the unchanged source document SHA-256, embedded image/crop preservation, and removal of temporary `.tmp.ai` files and the complete per-run temp directory. These synthetic fixture results are identified as such in the output.

If Illustrator COM automation is available, the smoke validates the generated native Illustrator file and requires both the file and the matching GUI success status before labeling that result `PASS`. It allows the configured 120-second automation timeout plus a 10-second renderer-status grace period. If Illustrator is unavailable, the test-only Cancel/SVG flow is recorded as `NOT_INSTALLED`. Automation failure and timeout fail the smoke. These outcomes are recorded separately from the synthetic fixture checks in the console and, when configured, a JSON result file.

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
