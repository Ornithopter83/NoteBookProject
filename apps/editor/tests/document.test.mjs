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
