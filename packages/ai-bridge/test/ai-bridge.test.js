import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAi, analyzePdfSubset, inspectAi, transformDocument, writePdf } from '../src/index.js';

const base = {
  format: 'pdf-compatible-ai-subset', pdfVersion: '1.4',
  pages: [{ width: 300, height: 200, items: [
    { type: 'path', paint: 'S', segments: [
      { op: 'M', points: [[10, 20]] }, { op: 'L', points: [[80, 20]] },
      { op: 'C', points: [[90, 30], [90, 50], [80, 60]] }, { op: 'Z', points: [] }
    ] },
    { type: 'text', text: 'Hello AI', position: [25, 40], fontSize: 14 }
  ] }]
};
function aiPdf(document = base) {
  return Buffer.from(writePdf(document).toString('ascii').replace('%AI-Bridge-Subset', '%AI1Bridge-Subset'), 'ascii');
}

function buildPdf(objects, root = 1) {
  const chunks = ['%PDF-1.4\n%AI1Fixture\n'];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0], 'ascii');
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(object);
    offset += Buffer.byteLength(object, 'ascii');
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id < offsets.length; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  chunks.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'ascii');
}

function nestedPageTreePdf(depth) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let level = 0; level < depth; level++) {
    const id = level + 2;
    const childId = id + 1;
    objects.push(`<< /Type /Pages /Count 1 /Kids [${childId} 0 R] >>`);
  }
  const pageId = depth + 2;
  const contentId = pageId + 1;
  objects.push(`<< /Type /Page /Parent ${pageId - 1} 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents ${contentId} 0 R >>`);
  objects.push('<< /Length 0 >>\nstream\n\nendstream');
  return buildPdf(objects);
}

test('recognizes compatible AI marker only after structural PDF validation', () => {
  const valid = aiPdf();
  assert.equal(inspectAi(valid).status, 'pdf-compatible-ai');
  assert.equal(inspectAi(valid).adobeCompatibility, 'unverified');
  assert.deepEqual(analyzeAi(valid).pages[0].items.map(item => item.type), ['path', 'text']);
  assert.equal(inspectAi(writePdf(base)).status, 'pdf-without-ai-marker');
  assert.ok(['invalid', 'unsupported'].includes(inspectAi(Buffer.from('not a pdf')).status));
});

test('reports bounded PDF support and rejects ambiguous or unsafe structures', () => {
  const twoPages = structuredClone(base);
  twoPages.pages.push(structuredClone(base.pages[0]));
  const multi = aiPdf(twoPages);
  assert.equal(inspectAi(multi).pages, 2);

  const source = aiPdf().toString('ascii');
  const compressed = source.replace('/Length ', '/Filter /FlateDecode /Length ');
  assert.equal(inspectAi(Buffer.from(compressed, 'ascii')).status, 'unsupported');

  const excessObjects = source.replace(/xref\n0 \d+/, 'xref\n0 100002');
  assert.equal(inspectAi(Buffer.from(excessObjects, 'ascii')).status, 'unsupported');

  const outOfRange = source.replace('10 20 m', '10000001 20 m');
  assert.equal(inspectAi(Buffer.from(outOfRange, 'ascii')).status, 'unsupported');

  const unicode = Buffer.from(source.replace('(Hello AI)', '(한글ab)'), 'utf8');
  assert.equal(inspectAi(unicode).status, 'unsupported');
  assert.throws(() => analyzeAi(unicode), { code: 'UNSUPPORTED_PDF' });

  const malformedXref = source.replace(/(\d{10}) 00000 n/, '0000000001 00000 n');
  assert.equal(inspectAi(Buffer.from(malformedXref, 'ascii')).status, 'invalid');
});

test('bounds input conversion and rejects deeply nested or inconsistent page trees', () => {
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
  assert.equal(inspectAi(oversized).status, 'unsupported');

  assert.equal(inspectAi(nestedPageTreePdf(130)).status, 'unsupported');

  const badCount = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'
  ]);
  assert.equal(inspectAi(badCount).status, 'invalid');

  const duplicatePageBox = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'
  ]);
  assert.equal(inspectAi(duplicatePageBox).status, 'unsupported');
});

test('rejects damaged xref offsets and unsupported operators', () => {
  const damaged = aiPdf().toString('ascii').replace(/(\d{10}) 00000 n/, '0000000001 00000 n');
  assert.equal(inspectAi(Buffer.from(damaged, 'ascii')).status, 'invalid');
  const unsupportedDoc = structuredClone(base);
  unsupportedDoc.pages[0].items[0].paint = 'S';
  const unsupported = aiPdf(unsupportedDoc).toString('ascii').replace('\nh\nS', '\nh\nq');
  const result = inspectAi(Buffer.from(unsupported, 'ascii'));
  assert.equal(result.status, 'unsupported');
  assert.match(result.reason, /unsupported/);

  const unsupportedColor = aiPdf().toString('ascii').replace('\nh\nS\n', '\nh\nrg\n');
  assert.notEqual(unsupportedColor, aiPdf().toString('ascii'));
  assert.equal(inspectAi(Buffer.from(unsupportedColor, 'ascii')).status, 'unsupported');
});

test('rejects unsupported page coordinate systems and text sequences without glyph advances', () => {
  const original = aiPdf().toString('ascii');
  const rotated = original.replace('/Parent', '/Rotate');
  assert.notEqual(rotated, original);
  assert.equal(inspectAi(Buffer.from(rotated, 'ascii')).status, 'unsupported');

  const alternateBox = original.replace('/MediaBox', '/BleedBox');
  assert.notEqual(alternateBox, original);
  assert.equal(inspectAi(Buffer.from(alternateBox, 'ascii')).status, 'unsupported');

  const consecutiveText = original.replace('(Hello AI) Tj ET', '() Tj (xy) Tj ET');
  assert.notEqual(consecutiveText, original);
  assert.equal(inspectAi(Buffer.from(consecutiveText, 'ascii')).status, 'unsupported');
});

test('transforms supported geometry and text and round-trips through PDF output', () => {
  const transformed = transformDocument(analyzeAi(aiPdf()), [2, 0, 0, 2, 5, -3]);
  assert.deepEqual(transformed.pages[0].items[0].segments[0].points[0], [25, 37]);
  assert.deepEqual(transformed.pages[0].items[1].position, [55, 77]);
  const output = writePdf(transformed);
  const reparsed = analyzePdfSubset(output);
  assert.equal(reparsed.pages.length, 1);
  assert.deepEqual(reparsed.pages[0].items.map(item => item.type), ['path', 'text']);
  assert.equal(reparsed.pages[0].items[1].text, 'Hello AI');
  assert.deepEqual(reparsed.pages[0].items[0].segments[1].points[0], [165, 37]);
});

test('rejects malformed transformations and non-ASCII text output', () => {
  assert.throws(() => transformDocument(base, [1, 0, 0, 1, Infinity, 0]), { code: 'INVALID_TRANSFORM' });
  const invalid = structuredClone(base); invalid.pages[0].items[1].text = '한글';
  assert.throws(() => writePdf(invalid), { code: 'INVALID_DOCUMENT' });
  const invalidPaint = structuredClone(base); invalidPaint.pages[0].items[0].paint = '__proto__';
  assert.throws(() => writePdf(invalidPaint), { code: 'INVALID_DOCUMENT' });
});
