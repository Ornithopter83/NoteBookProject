# M4 Windows package validation

## Package

`apps/editor` builds a Windows x64 ZIP with electron-builder (`npm run package:win`). The archive contains the Electron executable/runtime and `app.asar`, which carries the built main process, preload, renderer, package metadata, and production dependencies. The main-process build bundles the PSD Bridge, AI Bridge, and `ag-psd`; the Bridges therefore do not need a separately installed Node.js runtime on the target machine. PSD/AI behavior still depends on the Bridges' documented format support.

The GitHub Actions workflow at `.github/workflows/m4-packaging-validation.yml` creates the ZIP, extracts it on a Windows runner, checks for the packaged executable and `app.asar`, then launches that executable and runs the M3 GUI scenario against the real packaged process. That scenario exercises the renderer and preload bridge, edits a document, writes a `.nbdoc`, changes it, reopens the saved file, and verifies restored Unicode text and grouped layers. The job also runs the existing M1 `.nbdoc`, M2 PSD, M2 AI, and M3 development GUI smokes, plus editor checks.

The workflow writes the exact compressed and extracted sizes in bytes and MiB to the Actions job summary for each run. Package size varies with the pinned Electron/runtime dependency tree, so the CI measurement is the release evidence; use the successful run summary and artifact rather than a stale value recorded in this document.

## Signing and distribution limits

This package is **unsigned by Northstar and intended only for internal validation**. CI disables Electron Builder's certificate auto-discovery; no project code-signing certificate or timestamp service is configured. Windows SmartScreen or organizational endpoint policies may warn or block execution. Do not treat this artifact as a public release; production distribution needs an approved code-signing certificate, signing policy, and release process.

Adobe compatibility is **not verified**. The AI Bridge only imports its documented PDF-compatible Illustrator subset and does not interpret or preserve Illustrator-private data. The Windows workflow has no licensed Adobe Photoshop or Illustrator installation and does not validate round trips in those applications. PSD checks validate bridge behavior and the app's PSD smoke fixture, not compatibility with every Photoshop feature or version.

The package is x64 Windows only. The workflow validates on `windows-latest`; it does not establish support for every Windows release, ARM64, managed-device policy, or machines missing any Windows components that Electron may require. No installer, auto-updater, or production signing is included; users extract the ZIP to a writable folder and launch `Northstar Editor.exe`.

## Reading CI results

An artifact is uploaded only after all package and regression checks succeed. The packaged GUI smoke must connect to the launched app's Chromium DevTools endpoint, observe a mounted editor, save and reopen a `.nbdoc`, and report no renderer errors. The job summary records package sizes and identifies the artifact as unsigned. A failed step means the run did not validate the complete package path; consult that step's log before distributing the artifact.
