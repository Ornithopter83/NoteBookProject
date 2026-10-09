export type NodeKind = 'rect' | 'ellipse' | 'text' | 'image' | 'path' | 'aiText'

export interface NodeGroup {
  id: string
  name: string
  nodeIds: string[]
  x: number
  y: number
  width: number
  height: number
  rotation: number
  visible: boolean
  locked: boolean
}

export interface VectorSegment {
  op: 'M' | 'L' | 'C' | 'Z'
  points: number[][]
}

export interface EditorNode {
  id: string
  name: string
  kind: NodeKind
  x: number
  y: number
  width: number
  height: number
  fill: string
  opacity: number
  rotation: number
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  textAlign?: 'start' | 'middle' | 'end'
  src?: string
  resourcePath?: string
  pathSegments?: VectorSegment[]
  pathPaint?: 'S' | 's' | 'f' | 'F' | 'f*' | 'B' | 'B*' | 'b' | 'b*'
  visible: boolean
  locked: boolean
}

export interface EditorDocument {
  format: 'northstar-document'
  version: 1
  name: string
  width: number
  height: number
  background: string
  nodes: EditorNode[]
  /** Optional for version 1 compatibility; group membership and transforms are persisted here. */
  groups?: NodeGroup[]
}

export const createDocument = (): EditorDocument => ({
  format: 'northstar-document', version: 1, name: 'Untitled', width: 1440, height: 960,
  background: '#f5f4f0', nodes: [], groups: []
})

export function validateDocument(value: unknown): EditorDocument {
  if (!value || typeof value !== 'object') throw new Error('문서 데이터가 올바르지 않습니다.')
  const document = value as Partial<EditorDocument>
  if (document.format !== 'northstar-document' || document.version !== 1 || !Array.isArray(document.nodes)) {
    throw new Error('지원하지 않는 .nbdoc 형식입니다.')
  }
  if (!Number.isFinite(document.width) || !Number.isFinite(document.height) || document.width! <= 0 || document.height! <= 0) {
    throw new Error('문서 크기가 올바르지 않습니다.')
  }
  for (const node of document.nodes) {
    if (!node || !['rect', 'ellipse', 'text', 'image', 'path', 'aiText'].includes(node.kind) ||
      ![node.x, node.y, node.width, node.height, node.opacity, node.rotation].every(Number.isFinite) ||
      node.width <= 0 || node.height <= 0 || typeof node.id !== 'string' || !node.id ||
      typeof node.name !== 'string' || !/^#[\da-f]{3,8}$/i.test(node.fill) ||
      typeof node.visible !== 'boolean' || typeof node.locked !== 'boolean') {
      throw new Error('문서에 올바르지 않은 객체가 있습니다.')
    }
    if (node.kind === 'path') {
      if (!isValidPathSegments(node.pathSegments) || !['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(node.pathPaint ?? '')) throw new Error('벡터 경로 데이터가 올바르지 않습니다.')
    }
    if (node.kind === 'aiText' && (typeof node.text !== 'string' || !/^[\x20-\x7e]*$/.test(node.text) || !Number.isFinite(node.fontSize) || node.fontSize! <= 0)) throw new Error('AI 텍스트는 인쇄 가능한 ASCII와 양수 글꼴 크기여야 합니다.')
    if (node.kind === 'text' && node.text !== undefined && typeof node.text !== 'string') throw new Error('텍스트 데이터가 올바르지 않습니다.')
    if (node.fontFamily !== undefined && typeof node.fontFamily !== 'string') throw new Error('글꼴 이름이 올바르지 않습니다.')
    if (node.fontWeight !== undefined && (!Number.isFinite(node.fontWeight) || node.fontWeight < 100 || node.fontWeight > 900)) throw new Error('글꼴 굵기가 올바르지 않습니다.')
    if (node.textAlign !== undefined && !['start', 'middle', 'end'].includes(node.textAlign)) throw new Error('텍스트 정렬이 올바르지 않습니다.')
    if (node.src && (node.kind !== 'image' || !/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(node.src))) {
      throw new Error('이미지는 지원하는 데이터 형식이어야 합니다.')
    }
    if (node.resourcePath && !/^[^/\\]+\.assets\/[a-z\d_-]+\.(png|jpg|webp|gif)$/i.test(node.resourcePath)) {
      throw new Error('리소스 경로는 문서 기준 상대 경로여야 합니다.')
    }
  }
  const groups = document.groups ?? []
  if (!Array.isArray(groups)) throw new Error('그룹 데이터가 올바르지 않습니다.')
  const nodeIds = new Set<string>()
  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) throw new Error('객체 식별자가 중복되었습니다.')
    nodeIds.add(node.id)
  }
  const groupIds = new Set<string>()
  for (const group of groups) {
    if (!group || typeof group.id !== 'string' || !group.id || groupIds.has(group.id) || nodeIds.has(group.id) || typeof group.name !== 'string' ||
      !Array.isArray(group.nodeIds) || !group.nodeIds.length || group.nodeIds.some((id) => !nodeIds.has(id)) ||
      ![group.x, group.y, group.width, group.height, group.rotation].every(Number.isFinite) || group.width <= 0 || group.height <= 0 ||
      typeof group.visible !== 'boolean' || typeof group.locked !== 'boolean') throw new Error('그룹 데이터가 올바르지 않습니다.')
    groupIds.add(group.id)
  }
  const memberships = new Set<string>()
  for (const group of groups) for (const id of group.nodeIds) {
    if (memberships.has(id)) throw new Error('객체는 한 그룹에만 포함될 수 있습니다.')
    memberships.add(id)
  }
  return document as EditorDocument
}

export function isValidPathSegments(value: unknown): value is VectorSegment[] {
  if (!Array.isArray(value) || !value.length) return false
  return value.every((segment) => {
    if (!segment || typeof segment !== 'object') return false
    const candidate = segment as Partial<VectorSegment>
    const pointCount = candidate.op === 'C' ? 3 : candidate.op === 'Z' ? 0 : 1
    return ['M', 'L', 'C', 'Z'].includes(candidate.op ?? '') && Array.isArray(candidate.points) &&
      candidate.points.length === pointCount && candidate.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
  })
}

export function cloneDocument(document: EditorDocument): EditorDocument {
  return JSON.parse(JSON.stringify(document)) as EditorDocument
}
