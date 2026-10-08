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

test('recognizes compatible AI marker only after structural PDF validation', () => {
  const valid = aiPdf();
  assert.equal(inspectAi(valid).status, 'pdf-compatible-ai');
  assert.deepEqual(analyzeAi(valid).pages[0].items.map(item => item.type), ['path', 'text']);
  assert.equal(inspectAi(writePdf(base)).status, 'pdf-without-ai-marker');
  assert.ok(['invalid', 'unsupported'].includes(inspectAi(Buffer.from('not a pdf')).status));
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
});
