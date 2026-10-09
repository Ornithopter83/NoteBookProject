# @northstar/ai-bridge

A conservative, standalone PDF-compatible Illustrator inspection and vector/text interchange module. It does not read, preserve, or write Illustrator-native private data, and it never saves `.ai` files.

```js
import { inspectAi, analyzeAi, transformDocument, writePdf, analyzePdfSubset } from '@northstar/ai-bridge';

const report = inspectAi(pdfBytes); // pdf-compatible-ai | pdf-without-ai-marker | unsupported | invalid
if (report.status === 'pdf-compatible-ai') {
  const document = analyzeAi(pdfBytes);
  const archivedSource = document.originalBytes; // exact input bytes, copied and retained
  const moved = transformDocument(document, [1, 0, 0, 1, 12, 8]);
  const pdf = writePdf(moved);       // a new ordinary PDF, with unsupported/private data omitted
  const checked = analyzePdfSubset(pdf); // parse the emitted supported subset again
}
```

Supported inputs are PDF 1.4–1.7 with a single complete classic xref table, generation-zero indirect objects, zero-origin media boxes (direct or inherited from a page-tree node), and one unfiltered content stream per page. Inputs are limited to 64 MiB, 100,000 objects, 100,000 total page items, 250,000 path segments, 500 pages, and a page-tree depth of 128; absolute coordinates are limited to 10,000,000. The reader supports move/line/cubic/rectangle/close paths, including lossless normalization of `v` and `y` cubic shorthand, common paint operators, and unrotated printable-ASCII text (`Tf`, `Td`/`TD`, `Tm`, `Tj`); repeated `Tj` operations at one text position are rejected because glyph-advance metrics are not modeled. It checks xref offsets, counts, object references, page-tree counts, and trailer size before interpreting pages. Xref streams, incremental updates, object streams, compression, encryption, forms, images, clipping, graphics-state transforms, page rotation/scaling, alternate page boxes, annotations, page compositing groups, non-ASCII text, and graphics style/color operators are rejected. Since unsupported geometry, style, text encoding, and positioning cannot be represented faithfully, those inputs are rejected instead of approximated. Binary string inputs may contain only byte-valued characters; use `Uint8Array` for encoded data.

`analyzeAi` copies the exact source into `originalBytes`, including Illustrator private data, so callers can archive or export the untouched original. This byte copy is provenance only: transforms do not rewrite it, and `writePdf` creates a new ordinary PDF from the supported subset. It is not a native AI save operation.

`inspectAi` reports `adobeCompatibility: "unverified"`. This package contains generated structural test PDFs but no Illustrator-generated fixture with recorded provenance, Illustrator version, and PDF compatibility setting. The implemented PDF subset, including inherited page media boxes, is therefore verified only against generated fixtures; actual Illustrator compatibility remains unverified. Reclassify that status only when an Illustrator fixture and its provenance/settings are recorded and validated.

The output writer emits a fresh PDF with Helvetica text and path painting, with the same aggregate item/segment caps and a 64 MiB complete-file limit. It does not preserve original fonts, colors, line styles, page origins, metadata, or Illustrator private data. Only printable ASCII text is accepted, and unsupported PDF structures must be handled as unsupported rather than approximated.

Run `npm test` in this package (the `node:test` file can also be executed directly as `node test/ai-bridge.test.js`).
