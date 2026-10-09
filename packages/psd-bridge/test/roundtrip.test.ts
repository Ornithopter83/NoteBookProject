import assert from 'node:assert/strict';
import test from 'node:test';
import { writePsdBuffer, type Psd } from 'ag-psd';
import { openPsd, PsdBridgeError } from '../src/index.js';

const originalPixels = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 128,
  0, 0, 255, 255, 17, 34, 51, 0,
]);

function fixture(): Buffer {
  const psd: Psd = {
    width: 2,
    height: 2,
    children: [
      {
        name: '배경 그룹',
        left: 0,
        top: 0,
        children: [
          {
            name: '원본 픽셀',
            left: 3,
            top: -2,
            opacity: 0.8,
            imageData: { data: new Uint8ClampedArray(originalPixels), width: 2, height: 2 },
          },
        ],
      },
      { name: '빈 그룹', children: [] },
    ],
  };
  return writePsdBuffer(psd);
}

test('edits properties while preserving group structure and RGBA pixels over repeated PSD saves', () => {
  let document = openPsd(fixture());
  assert.equal(document.width, 2);
  assert.equal(document.height, 2);
  assert.equal(document.readTree()[0]?.kind, 'group');
  assert.equal(document.readTree()[0]?.children?.[0]?.kind, 'raster');

  document.editLayer('0', { name: '그룹 이름 변경' });
  document.editLayer('0.0', { name: '픽셀 레이어', left: 9, top: 11, visible: false, opacity: 0.35 });

  for (let saveNumber = 0; saveNumber < 3; saveNumber++) {
    document = openPsd(document.save());
    const tree = document.readTree();
    assert.equal(tree[0]?.name, '그룹 이름 변경');
    assert.equal(tree[0]?.children?.[0]?.name, '픽셀 레이어');
    assert.equal(tree[0]?.children?.[0]?.left, 9);
    assert.equal(tree[0]?.children?.[0]?.top, 11);
    assert.equal(tree[0]?.children?.[0]?.visible, false);
    assert.ok(Math.abs((tree[0]?.children?.[0]?.opacity ?? 0) - 0.35) <= 1 / 255);
    assert.deepEqual(document.getLayerPixels('0.0')?.data, originalPixels);
    assert.equal(tree[1]?.kind, 'group');
    assert.equal(tree[1]?.children?.length, 0);
  }
});

test('returns copied raster buffers so callers cannot mutate the PSD by accident', () => {
  const document = openPsd(fixture());
  const pixels = document.getLayerPixels('0.0');
  assert.ok(pixels);
  pixels.data[0] = 0;
  assert.equal(document.getLayerPixels('0.0')?.data[0], 255);
});

test('warns about and blocks saving high bit depth input to prevent precision loss', () => {
  const bytes = new Uint8Array(26 + 12 + 2 + 6);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x38425053, false); // 8BPS
  view.setUint16(4, 1, false);
  view.setUint16(12, 3, false);
  view.setUint32(14, 1, false);
  view.setUint32(18, 1, false);
  view.setUint16(22, 16, false);
  view.setUint16(24, 3, false); // RGB
  view.setUint32(26, 0, false); // color mode section
  view.setUint32(30, 0, false); // image resources
  view.setUint32(34, 0, false); // layer and mask info
  view.setUint16(38, 0, false); // raw composite compression
  const document = openPsd(bytes);
  assert.equal(document.bitDepth, 16);
  assert.ok(document.warnings.some((warning) => warning.message.includes('writer supports 8-bit output only')));
  assert.throws(() => document.save(), (error: unknown) => error instanceof PsdBridgeError && error.code === 'UNSUPPORTED_FORMAT');
});

test('rejects malformed files and configured size or layer-limit violations', () => {
  assert.throws(() => openPsd(new Uint8Array(26)), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INVALID_PSD');
  assert.throws(() => openPsd(fixture(), { maxFileBytes: 26 }), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INPUT_LIMIT');
  assert.throws(() => openPsd(fixture(), { maxLayers: 1 }), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INPUT_LIMIT');
});

test('rejects damaged headers, truncated sections, impossible dimensions, and unsupported bit depths before decoding', () => {
  const valid = fixture();
  for (const length of [0, 12, 25, 30, 37, Math.floor(valid.length / 2)]) {
    assert.throws(() => openPsd(valid.subarray(0, length)), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INVALID_PSD');
  }

  const badSignature = new Uint8Array(valid);
  badSignature[0] = 0;
  assert.throws(() => openPsd(badSignature), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INVALID_PSD');

  const impossibleSize = new Uint8Array(valid);
  new DataView(impossibleSize.buffer).setUint32(18, 0xffffffff, false);
  assert.throws(() => openPsd(impossibleSize), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INVALID_PSD');

  const tooLarge = new Uint8Array(valid);
  const tooLargeView = new DataView(tooLarge.buffer);
  tooLargeView.setUint32(14, 20_000, false);
  tooLargeView.setUint32(18, 20_000, false);
  assert.throws(() => openPsd(tooLarge), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INPUT_LIMIT');

  const unsupportedDepth = new Uint8Array(valid);
  new DataView(unsupportedDepth.buffer).setUint16(22, 24, false);
  assert.throws(() => openPsd(unsupportedDepth), (error: unknown) => error instanceof PsdBridgeError && error.code === 'UNSUPPORTED_FORMAT');
});

test('enforces decoded memory and pre-encoding output size limits', () => {
  assert.throws(
    () => openPsd(fixture(), { maxDecodedBytes: 8 }),
    (error: unknown) => error instanceof PsdBridgeError && error.code === 'INPUT_LIMIT',
  );
  const document = openPsd(fixture(), { maxFileBytes: 32 * 1024 });
  assert.throws(() => document.save(), (error: unknown) => error instanceof PsdBridgeError && error.code === 'OUTPUT_LIMIT');
});

test('counts layers across the complete hierarchy and retains the ordinary multi-layer round trip', () => {
  const psd: Psd = {
    width: 2,
    height: 2,
    children: Array.from({ length: 12 }, (_, index) => ({
      name: `레이어 ${index}`,
      imageData: { data: new Uint8ClampedArray(originalPixels), width: 2, height: 2 },
    })),
  };
  const bytes = writePsdBuffer(psd);
  assert.throws(() => openPsd(bytes, { maxLayers: 10 }), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INPUT_LIMIT');
  const opened = openPsd(bytes);
  assert.equal(opened.readTree().length, 12);
  assert.deepEqual(openPsd(opened.save()).getLayerPixels('11')?.data, originalPixels);
});

test('validates layer edits and unknown layer identifiers', () => {
  const document = openPsd(fixture());
  assert.throws(() => document.editLayer('0.0', { opacity: 1.5 }), (error: unknown) => error instanceof PsdBridgeError && error.code === 'INVALID_EDIT');
  assert.throws(() => document.editLayer('8', { visible: false }), (error: unknown) => error instanceof PsdBridgeError && error.code === 'LAYER_NOT_FOUND');
});
