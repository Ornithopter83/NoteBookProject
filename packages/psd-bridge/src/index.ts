import { initializeCanvas, readPsd, writePsdBuffer, type Layer, type PixelData, type Psd } from 'ag-psd';

export interface PsdBridgeLimits {
  maxFileBytes: number;
  maxCanvasPixels: number;
  maxLayers: number;
  maxDepth: number;
  maxDecodedBytes: number;
}

export const DEFAULT_LIMITS: Readonly<PsdBridgeLimits> = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxCanvasPixels: 100_000_000,
  maxLayers: 10_000,
  maxDepth: 64,
  maxDecodedBytes: 1024 * 1024 * 1024,
});

export type PsdLayerKind = 'group' | 'raster' | 'text' | 'adjustment' | 'smart-object' | 'vector' | 'empty';

export interface PsdLayerView {
  /** Stable within this opened document; path segments follow ag-psd's top-to-bottom order. */
  id: string;
  name: string;
  kind: PsdLayerKind;
  left: number;
  top: number;
  visible: boolean;
  opacity: number;
  children?: PsdLayerView[];
  pixels?: PixelData;
}

export interface LayerChanges {
  name?: string;
  left?: number;
  top?: number;
  visible?: boolean;
  opacity?: number;
}

export interface PsdBridgeWarning {
  code: 'special-layer' | 'document-feature' | 'unrecognized-feature';
  layerId?: string;
  message: string;
}

export interface OpenPsdOptions extends Partial<PsdBridgeLimits> {}

export class PsdBridgeError extends Error {
  constructor(message: string, public readonly code: 'INPUT_LIMIT' | 'INVALID_PSD' | 'UNSUPPORTED_FORMAT' | 'LAYER_NOT_FOUND' | 'INVALID_EDIT' | 'OUTPUT_LIMIT') {
    super(message);
    this.name = 'PsdBridgeError';
  }
}

function limitsFrom(options: OpenPsdOptions): PsdBridgeLimits {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PsdBridgeError(`The ${name} limit must be a positive safe integer.`, 'INVALID_EDIT');
    }
  }
  return limits;
}

let nodeImageDataInitialized = false;
function ensureNodeImageDataFactory(): void {
  if (nodeImageDataInitialized || typeof document !== 'undefined') return;
  // ag-psd calls its ImageData factory for 8-bit RGBA channels even when useImageData is enabled.
  // A canvas is deliberately unavailable in the Node bridge; pixel buffers stay unpremultiplied.
  initializeCanvas(
    () => { throw new Error('Canvas output is unavailable in the PSD bridge.'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
  );
  nodeImageDataInitialized = true;
}

function preflight(input: Uint8Array, limits: PsdBridgeLimits): void {
  if (input.byteLength > limits.maxFileBytes) throw new PsdBridgeError('PSD exceeds the configured file size limit.', 'INPUT_LIMIT');
  if (input.byteLength < 26) throw new PsdBridgeError('Input is shorter than the PSD header.', 'INVALID_PSD');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, false) !== 0x38425053) throw new PsdBridgeError('Input does not have a PSD 8BPS signature.', 'INVALID_PSD');
  const version = view.getUint16(4, false);
  if (version !== 1) throw new PsdBridgeError('Only version 1 PSD files are supported; PSB and unknown versions are rejected.', 'INVALID_PSD');
  const channels = view.getUint16(12, false);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const colorMode = view.getUint16(24, false);
  if (channels === 0 || channels > 56 || width === 0 || height === 0 || width > 30_000 || height > 30_000 || colorMode > 9) {
    throw new PsdBridgeError('PSD header contains invalid dimensions, channel count, or bit depth.', 'INVALID_PSD');
  }
  if (![8, 16, 32].includes(depth)) {
    throw new PsdBridgeError(`PSD bit depth ${depth} is unsupported; only 8-, 16-, and 32-bit documents can be read.`, 'UNSUPPORTED_FORMAT');
  }
  if (width * height > limits.maxCanvasPixels) throw new PsdBridgeError('PSD canvas exceeds the configured pixel limit.', 'INPUT_LIMIT');
  const estimatedDecodedBytes = width * height * Math.max(channels, 4) * Math.ceil(depth / 8);
  if (!Number.isSafeInteger(estimatedDecodedBytes) || estimatedDecodedBytes > limits.maxDecodedBytes) {
    throw new PsdBridgeError('PSD decoded image size exceeds the configured memory limit.', 'INPUT_LIMIT');
  }
  let offset = 26;
  const readLength = (at: number): number => {
    if (at < 0 || at + 4 > input.byteLength) throw new PsdBridgeError('PSD section length is truncated.', 'INVALID_PSD');
    return view.getUint32(at, false);
  };
  const colorModeEnd = offset + 4 + readLength(offset);
  if (colorModeEnd > input.byteLength) throw new PsdBridgeError('PSD color mode section exceeds the input.', 'INVALID_PSD');
  offset = colorModeEnd;
  const resourcesEnd = offset + 4 + readLength(offset);
  if (resourcesEnd > input.byteLength) throw new PsdBridgeError('PSD image resources section exceeds the input.', 'INVALID_PSD');
  offset = resourcesEnd;
  const layerMaskLength = readLength(offset);
  if (layerMaskLength > input.byteLength - (offset + 4)) throw new PsdBridgeError('PSD layer and mask section exceeds the input.', 'INVALID_PSD');
  const layerInfoOffset = offset + 8;
  const layerMaskEnd = offset + 4 + layerMaskLength;
  if (layerMaskLength >= 4 && layerInfoOffset + 2 <= layerMaskEnd) {
    const layerInfoLength = readLength(offset + 4);
    if (layerInfoLength > layerMaskEnd - layerInfoOffset) throw new PsdBridgeError('PSD layer info section exceeds the layer and mask section.', 'INVALID_PSD');
    if (layerInfoLength >= 2) {
      const layerCount = Math.abs(view.getInt16(layerInfoOffset, false));
      if (layerCount > limits.maxLayers) throw new PsdBridgeError('PSD contains more layers than the configured limit.', 'INPUT_LIMIT');
    }
  }
}

function layerKind(layer: Layer): PsdLayerKind {
  if (layer.children !== undefined) return 'group';
  if ('text' in layer) return 'text';
  if ('adjustment' in layer) return 'adjustment';
  if ('placedLayer' in layer) return 'smart-object';
  if ('vectorMask' in layer || 'vectorFill' in layer) return 'vector';
  if (layer.imageData || layer.canvas || layer.rawData) return 'raster';
  return 'empty';
}

function copyPixels(pixels: PixelData | undefined): PixelData | undefined {
  if (!pixels) return undefined;
  const data = pixels.data;
  let clone: PixelData['data'];
  if (data instanceof Uint8ClampedArray) clone = new Uint8ClampedArray(data);
  else if (data instanceof Uint8Array) clone = new Uint8Array(data);
  else if (data instanceof Uint16Array) clone = new Uint16Array(data);
  else clone = new Float32Array(data);
  return { data: clone, width: pixels.width, height: pixels.height };
}

function projectLayer(layer: Layer, id: string): PsdLayerView {
  const children = layer.children?.map((child, index) => projectLayer(child, `${id}.${index}`));
  const view: PsdLayerView = {
    id,
    name: layer.name ?? '',
    kind: layerKind(layer),
    left: layer.left ?? 0,
    top: layer.top ?? 0,
    visible: !layer.hidden,
    opacity: layer.opacity ?? 1,
  };
  if (children) view.children = children;
  const pixels = copyPixels(layer.imageData);
  if (pixels) view.pixels = pixels;
  return view;
}

function findLayer(layers: Layer[] | undefined, id: string): Layer | undefined {
  if (!layers || !/^\d+(?:\.\d+)*$/.test(id)) return undefined;
  const indices = id.split('.').map((part) => Number(part));
  if (indices.length === 0 || indices.some((index) => !Number.isInteger(index) || index < 0)) return undefined;
  let current: Layer | undefined;
  let siblings = layers;
  for (const index of indices) {
    current = siblings[index];
    if (!current) return undefined;
    siblings = current.children ?? [];
  }
  return current;
}

function scanWarnings(layers: Layer[] | undefined, parentId = ''): PsdBridgeWarning[] {
  const warnings: PsdBridgeWarning[] = [];
  (layers ?? []).forEach((layer, index) => {
    const id = parentId ? `${parentId}.${index}` : String(index);
    const kind = layerKind(layer);
    if (kind === 'text' || kind === 'adjustment' || kind === 'smart-object' || kind === 'vector') {
      warnings.push({
        code: 'special-layer',
        layerId: id,
        message: `Layer “${layer.name ?? ''}” is a ${kind} layer. This bridge does not guarantee Photoshop fidelity for it, so saving this document is blocked.`,
      });
    }
    if (layer.mask || layer.realMask || layer.effects || layer.blendingRanges) {
      warnings.push({
        code: 'document-feature',
        layerId: id,
        message: `Layer “${layer.name ?? ''}” has masks, effects, or blending ranges; saving is blocked because their fidelity is not guaranteed.`,
      });
    }
    warnings.push(...scanWarnings(layer.children, id));
  });
  return warnings;
}

function countLayers(layers: Layer[] | undefined, depth: number, limits: PsdBridgeLimits, counter: { count: number }): void {
  if (depth > limits.maxDepth) throw new PsdBridgeError('PSD layer nesting exceeds the configured depth limit.', 'INPUT_LIMIT');
  for (const layer of layers ?? []) {
    counter.count++;
    if (counter.count > limits.maxLayers) throw new PsdBridgeError('PSD contains more layers than the configured limit.', 'INPUT_LIMIT');
    countLayers(layer.children, depth + 1, limits, counter);
  }
}

function estimateOutputBytes(layers: Layer[] | undefined, width: number, height: number, sourceBytes: number): number {
  // The source size covers metadata whose serialized size is not represented in the layer model.
  // Add decoded pixels and record overhead conservatively before the writer allocates its buffer.
  let estimate = sourceBytes + width * height * 4 + 64 * 1024;
  const visit = (items: Layer[] | undefined): void => {
    for (const layer of items ?? []) {
      estimate += 1024;
      if (layer.imageData) estimate += layer.imageData.data.byteLength;
      else if (layer.rawData) {
        for (const channel of layer.rawData.channels) estimate += channel.data?.byteLength ?? 0;
      }
      if (!Number.isSafeInteger(estimate)) return;
      visit(layer.children);
    }
  };
  visit(layers);
  return estimate;
}

/** Editable PSD wrapper. Pixel buffers returned by getLayerPixels/readTree are copies. */
export class PsdBridgeDocument {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly warnings: readonly PsdBridgeWarning[];
  private readonly saveBlockers: readonly string[];
  private constructor(private readonly psd: Psd, private readonly limits: PsdBridgeLimits, private readonly sourceByteLength: number, missingFeatures: readonly string[]) {
    this.width = psd.width;
    this.height = psd.height;
    this.bitDepth = psd.bitsPerChannel ?? 8;
    this.saveBlockers = Object.freeze([
      ...(this.bitDepth !== 8 ? [`${this.bitDepth}-bit pixel data cannot be written without precision loss.`] : []),
      ...(psd.colorMode !== 3 ? [`Color mode ${psd.colorMode ?? 'unknown'} is not RGB and cannot be safely rewritten.`] : []),
      ...missingFeatures.map((feature) => `The PSD contains an unsupported feature (${feature}); rewriting could discard it.`),
      ...scanUnsafeLayers(psd.children),
    ]);
    this.warnings = Object.freeze([
      ...scanWarnings(psd.children),
      ...this.saveBlockers.map((message) => ({ code: 'unrecognized-feature' as const, message: `Saving is blocked: ${message}` })),
      { code: 'document-feature' as const, message: 'Layer edits do not regenerate the flattened composite preview. The target editor may rebuild it when opening the saved PSD; check the saved appearance.' },
    ]);
  }

  static open(input: Uint8Array, options: OpenPsdOptions = {}): PsdBridgeDocument {
    const limits = limitsFrom(options);
    preflight(input, limits);
    ensureNodeImageDataFactory();
    let psd: Psd;
    const missingFeatures: string[] = [];
    try {
      psd = readPsd(input, {
        useImageData: true,
        skipThumbnail: true,
        totalMemoryLimit: limits.maxDecodedBytes,
        logMissingFeatures: true,
        log: (...args: unknown[]) => missingFeatures.push(args.map(String).join(' ')),
      });
    } catch (error) {
      throw new PsdBridgeError(`Could not decode PSD: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_PSD');
    }
    countLayers(psd.children, 0, limits, { count: 0 });
    // ag-psd skips unknown additional-info records. Keep the document readable, but never
    // let a subsequent write silently discard data that was not represented in its model.
    return new PsdBridgeDocument(psd, limits, input.byteLength, missingFeatures);
  }

  readTree(): PsdLayerView[] {
    return (this.psd.children ?? []).map((layer, index) => projectLayer(layer, String(index)));
  }

  getLayerPixels(id: string): PixelData | undefined {
    const layer = findLayer(this.psd.children, id);
    if (!layer) throw new PsdBridgeError(`Layer “${id}” was not found.`, 'LAYER_NOT_FOUND');
    return copyPixels(layer.imageData);
  }

  editLayer(id: string, changes: LayerChanges): void {
    const layer = findLayer(this.psd.children, id);
    if (!layer) throw new PsdBridgeError(`Layer “${id}” was not found.`, 'LAYER_NOT_FOUND');
    if (changes.name !== undefined && (typeof changes.name !== 'string' || changes.name.length > 255)) {
      throw new PsdBridgeError('Layer name must be a string of at most 255 UTF-16 code units.', 'INVALID_EDIT');
    }
    if (changes.left !== undefined && (!Number.isSafeInteger(changes.left) || Math.abs(changes.left) > 300_000)) {
      throw new PsdBridgeError('Layer left offset must be an integer within ±300,000 pixels.', 'INVALID_EDIT');
    }
    if (changes.top !== undefined && (!Number.isSafeInteger(changes.top) || Math.abs(changes.top) > 300_000)) {
      throw new PsdBridgeError('Layer top offset must be an integer within ±300,000 pixels.', 'INVALID_EDIT');
    }
    if (changes.visible !== undefined && typeof changes.visible !== 'boolean') {
      throw new PsdBridgeError('Layer visibility must be a boolean.', 'INVALID_EDIT');
    }
    if (changes.opacity !== undefined && (!Number.isFinite(changes.opacity) || changes.opacity < 0 || changes.opacity > 1)) {
      throw new PsdBridgeError('Layer opacity must be between 0 and 1.', 'INVALID_EDIT');
    }
    if (changes.name !== undefined) {
      layer.name = changes.name;
    }
    if (changes.left !== undefined) {
      layer.left = changes.left;
    }
    if (changes.top !== undefined) {
      layer.top = changes.top;
    }
    if (changes.visible !== undefined) {
      layer.hidden = !changes.visible;
    }
    if (changes.opacity !== undefined) {
      layer.opacity = changes.opacity;
    }
  }

  save(): Buffer {
    if (this.saveBlockers.length) {
      throw new PsdBridgeError(`Saving is blocked to avoid losing unsupported PSD data: ${this.saveBlockers.join(' ')}`, 'UNSUPPORTED_FORMAT');
    }
    if (estimateOutputBytes(this.psd.children, this.width, this.height, this.sourceByteLength) > this.limits.maxFileBytes) {
      throw new PsdBridgeError('Estimated PSD output exceeds the configured file size limit; encoding was stopped before allocating the output buffer.', 'OUTPUT_LIMIT');
    }
    let output: Buffer;
    try {
      output = writePsdBuffer(this.psd, { trimImageData: false });
    } catch (error) {
      throw new PsdBridgeError(`Could not encode PSD: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_PSD');
    }
    if (output.byteLength > this.limits.maxFileBytes) throw new PsdBridgeError('Saved PSD exceeds the configured file size limit.', 'OUTPUT_LIMIT');
    return output;
  }
}

function scanUnsafeLayers(layers: Layer[] | undefined, parentId = ''): string[] {
  const blockers: string[] = [];
  (layers ?? []).forEach((layer, index) => {
    const id = parentId ? `${parentId}.${index}` : String(index);
    const kind = layerKind(layer);
    if (kind === 'text' || kind === 'adjustment' || kind === 'smart-object' || kind === 'vector') {
      blockers.push(`Layer ${id} (“${layer.name ?? ''}”) contains ${kind} data whose Photoshop fidelity is not guaranteed.`);
    }
    if (layer.mask || layer.realMask || layer.effects || layer.blendingRanges) {
      blockers.push(`Layer ${id} (“${layer.name ?? ''}”) contains masks, effects, or blending ranges that cannot be guaranteed to survive rewriting.`);
    }
    blockers.push(...scanUnsafeLayers(layer.children, id));
  });
  return blockers;
}

export function openPsd(input: Uint8Array, options?: OpenPsdOptions): PsdBridgeDocument {
  return PsdBridgeDocument.open(input, options);
}
