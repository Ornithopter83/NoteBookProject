export interface VectorizedImage {
  sourceWidth: number
  sourceHeight: number
  paths: { d: string; fill: string }[]
}

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_PIXELS = 16_777_216
const MAX_VECTOR_PATHS = 4096
const MAX_VECTOR_PATH_LENGTH = 200_000
const MAX_VECTOR_PATH_DATA_LENGTH = 2_000_000

function getImageDimensions(bytes: Uint8Array, mime: 'png' | 'jpeg'): { width: number; height: number } {
  if (mime === 'png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
      throw new Error('PNG 이미지 헤더를 읽지 못했습니다.')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue }
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) break
      return { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] }
    }
    offset += length
  }
  throw new Error('JPEG 이미지 크기 정보를 읽지 못했습니다.')
}

/**
 * Convert a PNG/JPEG data URL into color-reduced, closed SVG contours.
 * Work is capped at 256 pixels on the longest edge to keep interactive use bounded.
 */
export async function vectorizeImage(src: string): Promise<VectorizedImage> {
  if (!/^data:image\/(?:png|jpeg);base64,[a-z\d+/=]+$/i.test(src)) throw new Error('PNG 또는 JPEG 이미지에 대해서만 벡터화를 지원합니다.')
  const mime = src.slice(11, src.indexOf(';')).toLowerCase() as 'png' | 'jpeg'
  const encoded = src.slice(src.indexOf(',') + 1)
  if (encoded.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4) throw new Error('원본 이미지가 16 MiB 메모리 제한을 넘습니다.')
  const binary = atob(encoded)
  const sourceBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) throw new Error('원본 이미지가 16 MiB 메모리 제한을 넘습니다.')
  const dimensions = getImageDimensions(sourceBytes, mime)
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
    throw new Error('원본 이미지가 1,677만 픽셀 메모리 제한을 넘습니다.')
  }
  const image = new Image()
  image.src = src
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지 크기를 읽지 못했습니다.')
  const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('이미지를 분석할 캔버스를 만들지 못했습니다.')
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  // 4 levels per channel: at most 64 fills, preserving broad color regions.
  const colorAt = (x: number, y: number) => {
    const i = (y * width + x) * 4
    if (pixels[i + 3] < 128) return ''
    const q = (v: number) => Math.min(255, Math.round(v / 85) * 85).toString(16).padStart(2, '0')
    return `#${q(pixels[i])}${q(pixels[i + 1])}${q(pixels[i + 2])}`
  }
  const colors = new Set<string>()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colorAt(x, y)
    if (color) colors.add(color)
  }
  const output: VectorizedImage['paths'] = []
  let totalPathDataLength = 0
  for (const fill of colors) {
    // Cancel shared pixel edges; remaining directed edges form the color boundary.
    const edges = new Set<string>()
    const add = (ax: number, ay: number, bx: number, by: number) => {
      const forward = `${ax},${ay}>${bx},${by}`
      const reverse = `${bx},${by}>${ax},${ay}`
      if (edges.has(reverse)) edges.delete(reverse); else edges.add(forward)
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (colorAt(x, y) === fill) {
      if (!y || colorAt(x, y - 1) !== fill) add(x, y, x + 1, y)
      if (x === width - 1 || colorAt(x + 1, y) !== fill) add(x + 1, y, x + 1, y + 1)
      if (y === height - 1 || colorAt(x, y + 1) !== fill) add(x + 1, y + 1, x, y + 1)
      if (!x || colorAt(x - 1, y) !== fill) add(x, y + 1, x, y)
    }
    const outgoing = new Map<string, string[]>()
    for (const edge of edges) {
      const [from, to] = edge.split('>')
      const list = outgoing.get(from) ?? []
      list.push(to); outgoing.set(from, list)
    }
    while (outgoing.size) {
      const start = outgoing.keys().next().value as string
      let point = start
      const points: string[] = [start]
      let guard = edges.size + 1
      while (guard-- > 0) {
        const choices = outgoing.get(point)
        if (!choices?.length) break
        const next = choices.pop()!
        if (!choices.length) outgoing.delete(point)
        point = next
        if (point === start) break
        points.push(point)
      }
      if (point !== start || points.length < 4) continue
      // Drop collinear grid points so the SVG stays compact while retaining pixel contours.
      const xy = points.map((p) => p.split(',').map(Number) as [number, number])
      const reduced = xy.filter((p, i) => {
        const before = xy[(i + xy.length - 1) % xy.length], after = xy[(i + 1) % xy.length]
        return !((before[0] === p[0] && p[0] === after[0]) || (before[1] === p[1] && p[1] === after[1]))
      })
      if (reduced.length >= 3) {
        const d = `M${reduced.map(([x, y]) => `${x},${y}`).join('L')}Z`
        if (d.length > MAX_VECTOR_PATH_LENGTH) throw new Error('이미지 윤곽이 너무 복잡해 단일 경로 제한을 넘습니다. 해상도를 줄이거나 더 단순한 이미지를 선택해 주세요.')
        if (output.length >= MAX_VECTOR_PATHS || totalPathDataLength + d.length > MAX_VECTOR_PATH_DATA_LENGTH) {
          throw new Error('이미지 윤곽이 너무 복잡해 경로 수 또는 전체 경로 데이터 제한을 넘습니다. 해상도를 줄이거나 더 단순한 이미지를 선택해 주세요.')
        }
        totalPathDataLength += d.length
        output.push({ d, fill })
      }
    }
  }
  if (!output.length) throw new Error('벡터화할 불투명한 색상 영역을 찾지 못했습니다.')
  return { sourceWidth: width, sourceHeight: height, paths: output }
}
