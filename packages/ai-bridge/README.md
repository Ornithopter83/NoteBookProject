# @northstar/ai-bridge

A conservative, standalone PDF-compatible Illustrator inspection and vector/text interchange module. It does not read, preserve, or write Illustrator-native private data, and it never saves `.ai` files.

```js
import { inspectAi, analyzeAi, transformDocument, writePdf, analyzePdfSubset } from '@northstar/ai-bridge';

const report = inspectAi(pdfBytes); // pdf-compatible-ai | pdf-without-ai-marker | unsupported | invalid
if (report.status === 'pdf-compatible-ai') {
  const document = analyzeAi(pdfBytes);
  const moved = transformDocument(document, [1, 0, 0, 1, 12, 8]);
  const pdf = writePdf(moved);       // a new ordinary PDF, with unsupported/private data omitted
  const checked = analyzePdfSubset(pdf); // parse the emitted supported subset again
}
```

Supported inputs are PDF 1.4–1.7 with classic xref tables, generation-zero indirect objects, direct page tree and media boxes, and one unfiltered content stream per page. The reader supports basic move/line/cubic/rectangle/close path operators, common paint operators, and unrotated ASCII text (`Tf`, `Td`/`TD`, `Tm`, `Tj`). Xref streams, object streams, compression, encryption, forms, images, clipping, graphics-state transforms, non-ASCII text, and graphics style/color operators are rejected. Since style/color fidelity cannot be established, those operators are not silently discarded.

The output writer emits a fresh PDF with Helvetica text and path painting. It does not preserve original fonts, colors, line styles, page origins, metadata, or Illustrator private data. Only printable ASCII text is accepted, and unsupported PDF structures must be handled as unsupported rather than approximated.

Run `npm test` in this package (the `node:test` file can also be executed directly as `node test/ai-bridge.test.js`).
