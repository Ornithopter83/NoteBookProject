# M8 AI export GUI validation

The M8 GUI smoke is available as `npm run smoke:m8-gui` in `apps/editor` and runs from `TEST-NORTHSTAR.bat`. The M4 Windows workflow runs it once from the root launcher and records that run's JSON report and optional original SVG rendering as artifacts.

The smoke creates a synthetic 1440×960 photo document with an embedded JPEG. Its checks cover Illustrator-unavailable guidance, refusal to create a fake `.ai`, SVG and PDF alternatives, the unchanged source document SHA-256, embedded image/crop preservation, and removal of temporary `.tmp.ai` files and the complete per-run temp directory. These synthetic fixture results are identified as such in the output.

If Illustrator COM automation is available, the smoke allows the configured 120-second automation timeout plus a 10-second renderer-status grace period. It validates the generated native Illustrator file and requires the GUI status confirming the actual save and reopen path before labeling that result `PASS`. If Illustrator is unavailable, it records `NOT_INSTALLED` after checking the user guidance and fake-file prevention. Automation failure, cancellation, and timeout have distinct result labels and fail the smoke. These outcomes are recorded separately from the synthetic fixture checks in the console and, when configured, a JSON result file.

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
