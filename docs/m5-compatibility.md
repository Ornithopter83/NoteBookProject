# M5 PSD and Illustrator compatibility

## File safety

Opening a PSD records its canonical source path. Save opens a “PSD copy” dialog with an `-edited.psd` default name; the main process rejects a destination that resolves to the same path or file identity as the opened source. This includes an existing symbolic link or hard link to that source. A save rejection is returned through the renderer and shown in the status message. The M2 smoke saves to a second generated file so its source fixture remains unchanged.

AI imports are read-only. The source is opened through the PDF compatibility inspector and converted documents can only be saved as `.nbdoc`. The save path is checked against the canonical AI source, including links. PSD and AI reads are capped at 512 MiB and 64 MiB respectively; `.nbdoc` JSON is capped at 64 MiB. PSD bridge preflight additionally caps the canvas at 100 million pixels, 10,000 layers, depth 64, and estimated decoded data at 1 GiB. Encoded PSD output is limited to 512 MiB.

PSD text, adjustment, smart-object, and vector special-layer structures are listed as unsupported for saving and cause a clear save rejection. PSD version 2 / PSB, invalid or truncated structure, excessive dimensions, and unsupported bit depths are rejected during open. The bridge reads 8-, 16-, and 32-bit PSDs, but only writes 8-bit; saving higher bit depths is blocked to avoid precision loss. Masks, effects, blending ranges, and the flattened composite preview may render differently or remain stale after layer edits; they produce warnings and need visual review in Photoshop.

## Verified interchange scope

| Format | Current supported path | Known exclusions |
| --- | --- | --- |
| PSD | Classic version 1 PSD with supported raster/group layer records; rename, position, visibility, and opacity edits; save to a separate PSD and reopen | PSB, special layers, non-8-bit save, unsupported/corrupt records, full fidelity for effects/masks/composite preview |
| AI | One-page, PDF-compatible AI that passes the bridge's conservative PDF subset checks; vector paths and printable ASCII text are converted into editable Northstar objects and saved/reopened as `.nbdoc` | Illustrator private data is not interpreted or retained in the converted document; multipage files, unsupported PDF operators/structures, images, clipping, transforms, color/style features, and non-ASCII text are rejected |

AI inspection supports PDF 1.4–1.7 with a classic cross-reference table and the bridge's documented single-page object/content subset. It accepts common move, line, cubic, close, and paint operators plus unrotated printable-ASCII text. See the AI bridge README for exact parser bounds and rejected PDF features. This is a PDF interchange subset; it does not establish native `.ai` round-trip compatibility.

## GUI evidence and Adobe sample status

The M5 Windows GUI smoke creates a small PSD with a group and raster layer. It verifies that saving over the source is rejected with a visible message, that the source SHA-256 stays unchanged, and that an edited copy reopens with the changed layer name, offset, visibility, opacity, and original raster pixels. It also opens a generated PSD with effects and checks that the capability banner reports the save block and disables Save. It then runs the existing M2 AI GUI scenario, which imports a generated one-page PDF-compatible AI fixture, edits vector/text content, saves and reopens `.nbdoc`, and compares the source AI hash and saved geometry/text. These are generated fixtures, not Adobe-authored samples. The M2 PSD smoke now also saves to a distinct copy path and checks that its source fixture is unchanged.

No Adobe Photoshop or Illustrator executable, nor any Adobe-authored `.psd` or `.ai` sample, was present in the available workspace/runtime during this work. Therefore no genuine Adobe sample or round trip was verified, and the supported subset must not be described as Adobe-certified. To validate Adobe-origin files, record each sample's source application/version, save options (including PDF compatibility for AI), sample hash, and observed open/edit/save/reopen behavior before expanding this compatibility claim.

The M5 Windows Actions workflow runs M1–M4 editor regressions, the M5 GUI scenarios, Windows ZIP packaging, and the packaged-app GUI smoke. It does not install licensed Adobe applications. This HIGH follow-up passed PSD bridge tests (10/10), AI bridge tests (9/9), the editor typecheck, the M2 and M5 smoke-script syntax checks, and both editor unit-test files run directly (8/8). The PSD bridge build also passed. The aggregate editor test runner, editor build, and Electron GUI launches failed before exercising the code because child-process creation returned `spawn EPERM`; no post-change GUI or package pass is claimed from this run. The supplied earlier QA recorded M5, M1, M2, and M3 GUI passes before the latest UI status and smoke changes. Run the Windows workflow to verify the updated smokes and packaged application.
