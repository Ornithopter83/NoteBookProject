# PSD Bridge

Standalone TypeScript PSD reader/editor/writer built on `ag-psd`. It reads the PSD layer tree and unpremultiplied raster pixel buffers, edits layer names, offsets, visibility, and opacity, then writes standard PSD bytes that can be opened again with `openPsd`.

```ts
import { openPsd } from '@northstar/psd-bridge';

const document = openPsd(psdBytes);
const layers = document.readTree();
const rgba = document.getLayerPixels('0.1');
document.editLayer('0.1', { name: '배경', left: 24, top: 12, visible: true, opacity: 0.8 });
const savedPsd = document.save();
const reopened = openPsd(savedPsd);
```

Layer IDs are dot-separated indices in PSD top-to-bottom order and remain stable while the current document's tree is not structurally changed. `readTree()` and `getLayerPixels()` return copies of pixel buffers. ag-psd can decode 8-, 16-, and 32-bit pixels, but its writer currently supports 8-bit documents only. The bridge blocks saving a 16- or 32-bit file so it cannot silently lose precision. Layer opacity in PSD is an 8-bit value and is quantized by the file format when saved.

## Limits and warnings

Default input limits are 512 MiB per PSD, 100 million canvas pixels, 10,000 layers, 64 group levels, and 1 GiB of decoded image buffers. Callers can override these limits per `openPsd` invocation. The bridge preflights the PSD signature, version, dimensions, channels, and bit depth before parsing. PSB is rejected.

`document.warnings` reports special layers (text, adjustment, smart object, and vector), masks/effects/blending ranges, and the fact that a layer edit does not redraw the flattened composite preview. These source properties are passed through when supported by ag-psd, but the bridge does not render those layer types or regenerate the flattened preview; inspect edited files in the target editor. ag-psd feature coverage is not full Photoshop fidelity, so the bridge is intended for ordinary layered PSDs and explicit warnings should be surfaced to users before saving.

The bridge does not modify raster pixels. Pixel data is exposed for reading and copied to prevent accidental mutation. Layer names, positions, visibility, opacity, and nested group structure are editable/preserved.

## Development

Run `npm install`, `npm run build`, and `npm test`. The test suite makes a nested-group RGBA fixture and verifies the edited document through three save/reopen cycles, as well as input limits and edit validation.
