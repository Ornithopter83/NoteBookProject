import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocument, validateDocument } from '../src/shared/document.ts'

test('creates a valid empty .nbdoc document', () => {
  assert.deepEqual(validateDocument(createDocument()).nodes, [])
})

test('accepts relative image paths and rejects traversal', () => {
  const document = { ...createDocument(), nodes: [{ id: 'image-1', name: 'Image', kind: 'image', x: 0, y: 0, width: 20, height: 20, fill: '#fff', opacity: 100, rotation: 0, visible: true, locked: false, resourcePath: 'Untitled.assets/image-1.png' }] }
  assert.match(validateDocument(document).nodes[0].resourcePath, /Untitled\.assets/)
  assert.throws(() => validateDocument({ ...document, nodes: [{ ...document.nodes[0], resourcePath: '../outside.png' }] }), /상대 경로/)
})

test('rejects invalid dimensions and unsupported versions', () => {
  assert.throws(() => validateDocument({ ...createDocument(), width: 0 }), /문서 크기/)
  assert.throws(() => validateDocument({ ...createDocument(), version: 2 }), /지원하지 않는/)
})

test('keeps version 1 documents without group metadata backward compatible', () => {
  const legacy = { ...createDocument(), nodes: [{ id: 'rect-1', name: '기존 사각형', kind: 'rect', x: 4, y: 8, width: 20, height: 30, fill: '#fff', opacity: 100, rotation: 0, visible: true, locked: false }] }
  delete legacy.groups
  assert.equal(validateDocument(legacy).nodes[0].name, '기존 사각형')
})

test('validates persisted groups and rejects duplicate membership', () => {
  const node = { id: 'rect-1', name: '사각형', kind: 'rect', x: 0, y: 0, width: 20, height: 30, fill: '#fff', opacity: 100, rotation: 0, visible: true, locked: false }
  const group = { id: 'group-1', name: '그룹 1', nodeIds: ['rect-1'], x: 0, y: 0, width: 20, height: 30, rotation: 0, visible: true, locked: false }
  const document = { ...createDocument(), nodes: [node], groups: [group] }
  assert.equal(validateDocument(document).groups[0].nodeIds[0], node.id)
  assert.throws(() => validateDocument({ ...document, groups: [group, { ...group, id: 'group-2' }] }), /한 그룹에만/)
  assert.throws(() => validateDocument({ ...document, groups: [group, { ...group, name: '중복 그룹 ID' }] }), /그룹 데이터/)
})

test('rejects duplicate and colliding IDs and multiple group parents', () => {
  const node = { id: 'rect-1', name: '사각형', kind: 'rect', x: 0, y: 0, width: 20, height: 30, fill: '#fff', opacity: 100, rotation: 0, visible: true, locked: false }
  const group = { id: 'group-1', name: '그룹', nodeIds: ['rect-1'], x: 0, y: 0, width: 20, height: 30, rotation: 0, visible: true, locked: false }
  const document = { ...createDocument(), nodes: [node], groups: [group] }
  assert.equal(validateDocument(document).groups[0].nodeIds[0], node.id)
  assert.throws(() => validateDocument({ ...document, groups: [group, { ...group, id: 'group-2' }] }), /한 그룹에만/)
  assert.throws(() => validateDocument({ ...document, nodes: [node, { ...node }] }), /식별자가 중복/)
  assert.throws(() => validateDocument({ ...document, groups: [{ ...group, id: node.id }] }), /그룹 데이터/)
})

test('preserves vector path data and group transform metadata during validation', () => {
  const path = { id: 'path-1', name: '경로', kind: 'path', x: 1, y: 2, width: 10, height: 12, fill: '#fff', opacity: 100, rotation: 0, visible: true, locked: false, pathPaint: 'B', pathSegments: [{ op: 'M', points: [[1, 2]] }, { op: 'C', points: [[2, 3], [4, 5], [6, 7]] }] }
  const group = { id: 'group-1', name: '그룹', nodeIds: [path.id], x: 3.25, y: 4.5, width: 20.5, height: 24.75, rotation: 17.5, visible: true, locked: false }
  const validated = validateDocument({ ...createDocument(), nodes: [path], groups: [group] })
  assert.deepEqual(validated.nodes[0].pathSegments, path.pathSegments)
  assert.equal(validated.groups[0].x, 3.25)
  assert.equal(validated.groups[0].y, 4.5)
  assert.equal(validated.groups[0].width, 20.5)
  assert.equal(validated.groups[0].height, 24.75)
  assert.equal(validated.groups[0].rotation, 17.5)
  assert.throws(() => validateDocument({ ...createDocument(), nodes: [{ ...path, pathSegments: [{ op: 'C', points: [[1, 2]] }] }] }), /벡터 경로 데이터/)
})
