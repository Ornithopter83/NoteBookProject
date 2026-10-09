import React, { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { AlignLeft, ArrowDown, ArrowUp, ChevronDown, Circle, Download, Eye, EyeOff, FileImage, FilePlus2, Grid2X2, ImagePlus, Layers, LockKeyhole, MousePointer2, Redo2, Save, Square, Type, Undo2, X } from 'lucide-react'
import { cloneDocument, createDocument, isValidPathSegments, type EditorDocument, type EditorNode, type NodeGroup, type NodeKind } from '../../shared/document'
import type { PsdEditorDocument } from '../../preload'
import type { LayerChanges, PsdLayerView } from '@northstar/psd-bridge'

type Tool = 'select' | 'rect' | 'ellipse' | 'text'
const palettes = ['#f97352', '#f7b955', '#b5ca74', '#62b7a6', '#6797d3', '#a18ad3', '#ed8ca2', '#252629']
const makeId = () => `layer-${Math.random().toString(36).slice(2, 9)}`
const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)

export default function App() {
  const [document, setDocument] = useState<EditorDocument>(() => createDocument())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(82)
  const [history, setHistory] = useState<EditorDocument[]>([])
  const [future, setFuture] = useState<EditorDocument[]>([])
  const [message, setMessage] = useState('모든 변경 사항이 저장되었습니다')
  const [exportOpen, setExportOpen] = useState(false)
  const [psd, setPsd] = useState<PsdEditorDocument | null>(null)
  const [psdEdits, setPsdEdits] = useState<Record<string, LayerChanges>>({})
  const [selectedPsdId, setSelectedPsdId] = useState<string | null>(null)
  const [aiImport, setAiImport] = useState<{ pdfVersion: string; sourceName: string; limitations: string } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ ids: string[]; groupId?: string; x: number; y: number; before: EditorDocument } | null>(null)
  const selected = document.nodes.find((node) => node.id === selectedId) ?? null
  const selectedGroup = document.groups?.find((group) => group.id === selectedGroupId) ?? null
  const canGroupSelection = selectedIds.length > 1 && selectedIds.every((id) => !(document.groups ?? []).some((group) => group.nodeIds.includes(id)))
  const allocateId = () => {
    const used = new Set([...document.nodes.map((node) => node.id), ...(document.groups ?? []).map((group) => group.id)])
    let id = makeId()
    while (used.has(id)) id = makeId()
    return id
  }
  const selectedPsd = psd ? findPsdLayer(psd.layers, selectedPsdId) : null
  const effectivePsdLayer = selectedPsd ? { ...selectedPsd, ...psdEdits[selectedPsd.id] } : null
  const psdSaveBlocked = hasPsdSaveBlocker(psd)

  const commit = useCallback((next: EditorDocument) => {
    setHistory((items) => [...items.slice(-49), cloneDocument(document)])
    setFuture([])
    setDocument(next)
    setMessage('저장되지 않은 변경 사항')
  }, [document])

  const updateNode = (id: string, patch: Partial<EditorNode>) => {
    const current = document.nodes.find((node) => node.id === id)
    if (!current || [patch.width, patch.height, patch.fontSize].some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0)) ||
      (patch.fontWeight !== undefined && (!Number.isFinite(patch.fontWeight) || patch.fontWeight < 100 || patch.fontWeight > 900))) return
    const group = (document.groups ?? []).find((item) => item.nodeIds.includes(id))
    const metadataOnly = Object.keys(patch).every((key) => key === 'visible' || key === 'locked')
    if ((current.locked || group?.locked) && !metadataOnly) return
    commit({ ...document, nodes: document.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) })
  }
  const updatePsdLayer = (id: string, changes: LayerChanges) => {
    setPsdEdits((current) => ({ ...current, [id]: { ...current[id], ...changes } }))
    setPsd((current) => current ? { ...current, layers: patchPsdTree(current.layers, id, changes) } : current)
    setMessage('저장되지 않은 PSD 변경 사항')
  }
  const undo = useCallback(() => {
    if (!history.length) return
    setFuture((items) => [cloneDocument(document), ...items])
    setDocument(history[history.length - 1])
    setHistory((items) => items.slice(0, -1))
    setMessage('실행 취소됨')
  }, [document, history])
  const redo = useCallback(() => {
    if (!future.length) return
    setHistory((items) => [...items, cloneDocument(document)])
    setDocument(future[0])
    setFuture((items) => items.slice(1))
    setMessage('다시 실행됨')
  }, [document, future])

  const addNode = (kind: NodeKind, x = 190 + document.nodes.length * 24, y = 160 + document.nodes.length * 18, src?: string) => {
    const index = document.nodes.filter((node) => node.kind === kind).length + 1
    const node: EditorNode = { id: allocateId(), kind, name: `${kind === 'rect' ? '사각형' : kind === 'ellipse' ? '타원' : kind === 'text' ? '텍스트' : '이미지'} ${index}`, x, y, width: kind === 'text' ? 330 : kind === 'image' ? 260 : 240, height: kind === 'text' ? 76 : kind === 'image' ? 190 : 180, fill: kind === 'text' ? '#252629' : palettes[(document.nodes.length + 1) % palettes.length], opacity: 100, rotation: 0, visible: true, locked: false, ...(kind === 'text' ? { text: '새로운 아이디어', fontSize: 40 } : {}), ...(src ? { src } : {}) }
    commit({ ...document, nodes: [...document.nodes, node] })
    setSelectedId(node.id); setSelectedIds([node.id]); setSelectedGroupId(null)
    setTool('select')
  }

  const save = async () => {
    if (psdSaveBlocked) {
      setMessage('지원되지 않는 PSD 데이터가 있어 저장할 수 없습니다.')
      return
    }
    try {
      if (psd) {
        const edits = Object.entries(psdEdits).map(([id, changes]) => ({ id, changes }))
        const result = await window.northstar.savePsd(psd.sessionId, edits)
        if (result) setMessage('PSD를 저장했습니다. 레이어 구조를 유지했습니다.')
      } else {
        if (aiImport) setMessage('AI 변환 문서를 .nbdoc로 저장 중')
        const result = await window.northstar.saveDocument(document)
        if (result) { setDocument({ ...document, name: result.document.name }); setMessage(aiImport ? 'AI 변환 문서를 .nbdoc로 저장했습니다' : '모든 변경 사항이 저장되었습니다') }
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : '저장에 실패했습니다') }
  }
  const exportFile = async (format: 'png' | 'jpeg' | 'svg' | 'pdf' | 'psd' | 'ai') => {
    setExportOpen(false)
    if (format === 'ai' && !window.confirm('현재 캔버스를 Illustrator에서 열어 네이티브 .ai 파일로 저장합니다. 사진은 포함된 JPEG 래스터 이미지로 유지되며 벡터화되지 않습니다. 계속할까요?')) return
    if (format === 'psd') {
      const sourceWarnings = psd?.warnings.filter((warning) => !warning.message.startsWith('Layer edits do not regenerate the flattened composite preview.')) ?? []
      const warningDetails = sourceWarnings.length ? `\n\n원본 PSD 확인 사항:\n${sourceWarnings.slice(0, 4).map((warning) => `• ${warning.message}`).join('\n')}${sourceWarnings.length > 4 ? `\n• 외 ${sourceWarnings.length - 4}개 항목` : ''}` : ''
      if (!window.confirm(`PSD는 현재 캔버스를 8비트 RGB 단일 병합 레이어로 내보냅니다. 편집 가능한 레이어는 보존되지 않습니다.${warningDetails}\n\n계속할까요?`)) return
    }
    if (format === 'pdf' && !window.confirm('PDF는 캔버스 모양을 유지하는 평면 이미지로 내보냅니다. 계속할까요?')) return
    if (format === 'svg' && !psd && document.nodes.some((node) => node.kind === 'text' || node.kind === 'aiText') &&
      !window.confirm('SVG 텍스트는 편집 가능한 글자로 보존됩니다. 글꼴 파일은 포함하지 않으므로 다른 컴퓨터에서 글꼴이 대체될 수 있습니다. 계속할까요?')) return
    try {
      const width = psd?.width ?? document.width; const height = psd?.height ?? document.height
      const svg = psd ? createPsdSvg(psd.layers, psd.width, psd.height, psdEdits) : createExportSvg(svgRef.current, document.width, document.height, document.background)
      if (format === 'svg') {
        const result = await window.northstar.exportFile({ format, width, height, svg, name: psd?.name ?? document.name })
        if (result) setMessage(`SVG를 내보냈습니다 · ${result.filePath}`)
        return
      }
      if (format === 'ai') {
        const result = await window.northstar.exportFile({ format, width, height, svg, name: psd?.name ?? document.name })
        if (result) setMessage(`Illustrator AI를 저장했습니다 · ${result.filePath}`)
        return
      }
      const image = new Image()
      const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      try { image.src = svgUrl; await image.decode() } finally { URL.revokeObjectURL(svgUrl) }
      const canvas = window.document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('캔버스를 만들지 못했습니다.')
      if (format === 'jpeg' || format === 'pdf' || format === 'psd') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height) }
      context.drawImage(image, 0, 0, width, height)
      if (format === 'png' || format === 'jpeg') {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('이미지 인코딩에 실패했습니다.')), format === 'png' ? 'image/png' : 'image/jpeg', 0.92))
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const result = await window.northstar.exportFile({ format, width, height, image: bytes, name: psd?.name ?? document.name })
        if (result) setMessage(`${format.toUpperCase()}를 내보냈습니다 · ${result.filePath}`)
      } else {
        const pixels = context.getImageData(0, 0, width, height).data
        const result = await window.northstar.exportFile({ format, width, height, pixels: new Uint8Array(pixels), name: psd?.name ?? document.name })
        if (result) setMessage(`${format.toUpperCase()}를 내보냈습니다 · ${result.filePath}`)
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : '내보내기에 실패했습니다') }
  }
  const open = async () => {
    try {
      const result = await window.northstar.openDocument()
      if (result) {
        setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null); setSelectedPsdId(null); setHistory([]); setFuture([]); setPsdEdits({})
        if (result.psd) { setAiImport(null); setPsd(result.psd); setDocument(createDocument()); setMessage(`PSD 열기 · ${result.psd.warnings.length}개 확인 사항`) }
        else if (result.document) { setPsd(null); setAiImport(result.aiImport ?? null); setDocument(result.document); setMessage(result.aiImport ? `AI 가져오기 · PDF ${result.aiImport.pdfVersion}` : '문서를 열었습니다') }
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : '문서를 열지 못했습니다') }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
      if (event.key === 'Escape') setTool('select')
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) {
        const removableIds = selectedIds.filter((id) => {
          const node = document.nodes.find((item) => item.id === id)
          const group = (document.groups ?? []).find((item) => item.nodeIds.includes(id))
          return node && !node.locked && !group?.locked
        })
        if (removableIds.length) {
          commit({ ...document, nodes: document.nodes.filter((node) => !removableIds.includes(node.id)), groups: (document.groups ?? []).map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !removableIds.includes(id)) })).filter((group) => group.nodeIds.length > 0) })
          const remaining = selectedIds.filter((id) => !removableIds.includes(id)); setSelectedId(remaining.at(-1) ?? null); setSelectedIds(remaining)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commit, document, redo, save, selectedIds, undo])

  const canvasPoint = (event: React.PointerEvent<SVGElement>) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return { x: 0, y: 0 }
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const canvasPoint = point.matrixTransform(matrix.inverse())
    return { x: canvasPoint.x, y: canvasPoint.y }
  }
  const onCanvasDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as SVGElement).closest('[data-node]')) return
    const point = canvasPoint(event)
    if (tool !== 'select') { addNode(tool, point.x, point.y); return }
    setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null)
  }
  const onNodeDown = (event: React.PointerEvent<SVGElement>, node: EditorNode) => {
    event.stopPropagation()
    if (event.ctrlKey || event.metaKey) {
      const next = selectedIds.includes(node.id) ? selectedIds.filter((id) => id !== node.id) : [...selectedIds, node.id]
      setSelectedIds(next); setSelectedId(next.at(-1) ?? null); setSelectedGroupId(null)
      return
    }
    const group = (document.groups ?? []).find((candidate) => candidate.nodeIds.includes(node.id))
    const ids = selectedIds.includes(node.id) ? selectedIds : [node.id]
    if (group) { setSelectedIds([]); setSelectedId(null); setSelectedGroupId(group.id) }
    else { setSelectedIds(ids); setSelectedId(node.id); setSelectedGroupId(null) }
    const movingIds = group ? group.nodeIds : ids
    if (tool !== 'select' || node.locked || group?.locked || movingIds.some((id) => document.nodes.find((item) => item.id === id)?.locked)) return
    const point = canvasPoint(event)
    dragRef.current = { ids: movingIds, groupId: group?.id, x: point.x, y: point.y, before: cloneDocument(document) }
    ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
  }
  const onNodeMove = (event: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const point = canvasPoint(event)
    const dx = point.x - drag.x; const dy = point.y - drag.y
    setDocument((current) => ({ ...current, groups: drag.groupId ? (current.groups ?? []).map((group) => {
      if (group.id !== drag.groupId) return group
      const original = drag.before.groups?.find((item) => item.id === group.id)
      return original ? { ...group, x: original.x + dx, y: original.y + dy } : group
    }) : current.groups, nodes: current.nodes.map((node) => {
      if (!drag.ids.includes(node.id)) return node
      const original = drag.before.nodes.find((item) => item.id === node.id)
      if (!original) return node
      if (node.kind === 'path') {
        if (original.kind !== 'path') return node
        return { ...node, x: original.x + dx, y: original.y - dy, pathSegments: original.pathSegments?.map((segment) => ({ ...segment, points: segment.points.map(([x, y]) => [x + dx, y - dy]) })) }
      }
      return { ...node, x: original.x + dx, y: original.y + (node.kind === 'aiText' ? -dy : dy) }
    }) }))
  }
  const onNodeUp = () => {
    const drag = dragRef.current
    if (!drag) return
    const before = drag.before
    dragRef.current = null
    if (JSON.stringify(before.nodes) === JSON.stringify(document.nodes) && JSON.stringify(before.groups ?? []) === JSON.stringify(document.groups ?? [])) return
    setHistory((items) => [...items.slice(-49), before]); setFuture([]); setMessage('저장되지 않은 변경 사항')
  }

  const importImage = async () => { const src = await window.northstar.importImage(); if (src) addNode('image', undefined, undefined, src) }
  const editDimension = (key: 'x' | 'y' | 'width' | 'height' | 'rotation', event: ChangeEvent<HTMLInputElement>) => {
    if (!selected) return
    const value = Number(event.target.value)
    if (!Number.isFinite(value) || ((key === 'width' || key === 'height') && value <= 0)) return
    const parentGroup = (document.groups ?? []).find((group) => group.nodeIds.includes(selected.id))
    if (selected.locked || parentGroup?.locked) return
    if (selected.kind === 'path') {
      if (key === 'rotation') { updateNode(selected.id, { rotation: value }); return }
      const sx = key === 'width' ? value / selected.width : 1; const sy = key === 'height' ? value / selected.height : 1
      const dx = key === 'x' ? value - selected.x : 0; const dy = key === 'y' ? selected.y - value : 0
      const top = document.height - selected.y - selected.height
      const pathSegments = selected.pathSegments?.map((segment) => ({ ...segment, points: segment.points.map(([x, y]) => {
        let px = selected.x + (x - selected.x) * sx + dx
        let py = top + ((document.height - y) - top) * sy + dy
        return [px, document.height - py]
      }) }))
      updateNode(selected.id, { [key]: value, pathSegments })
    } else if (selected.kind === 'text' && key === 'height') updateNode(selected.id, { height: value, fontSize: Math.max(1, (selected.fontSize ?? 40) * value / selected.height) })
    else updateNode(selected.id, { [key]: value })
  }
  const reorder = (id: string, direction: -1 | 1) => {
    const selectedNode = document.nodes.find((node) => node.id === id)
    const parentGroup = (document.groups ?? []).find((group) => group.nodeIds.includes(id))
    if (selectedNode?.locked || parentGroup?.locked) return
    const index = document.nodes.findIndex((node) => node.id === id); const nextIndex = Math.max(0, Math.min(document.nodes.length - 1, index + direction))
    if (index === nextIndex) return
    const nodes = [...document.nodes]; [nodes[index], nodes[nextIndex]] = [nodes[nextIndex], nodes[index]]; commit({ ...document, nodes })
  }
  const groupSelection = () => {
    if (!canGroupSelection) return
    const ids = selectedIds
    if (ids.length < 2) return
    const nodes = document.nodes.filter((node) => ids.includes(node.id))
    const bounds = getObjectsBounds(nodes, document.height)
    const group: NodeGroup = { id: allocateId(), name: `그룹 ${(document.groups?.length ?? 0) + 1}`, nodeIds: nodes.map((node) => node.id), ...bounds, rotation: 0, visible: true, locked: false }
    commit({ ...document, groups: [...(document.groups ?? []), group] }); setSelectedGroupId(group.id); setSelectedId(null); setSelectedIds([])
  }
  const ungroupSelection = () => {
    if (!selectedGroup || selectedGroup.locked) return
    const ids = selectedGroup.nodeIds
    commit({ ...document, groups: (document.groups ?? []).filter((group) => group.id !== selectedGroup.id) }); setSelectedGroupId(null); setSelectedIds(ids); setSelectedId(ids[0] ?? null)
  }
  const transformGroup = (key: 'x' | 'y' | 'width' | 'height' | 'rotation', value: number) => {
    if (!selectedGroup || selectedGroup.locked || selectedGroup.nodeIds.some((id) => document.nodes.find((node) => node.id === id)?.locked) || !Number.isFinite(value) || ((key === 'width' || key === 'height') && value <= 0)) return
    const next = { ...selectedGroup, [key]: value }
    const sx = next.width / selectedGroup.width; const sy = next.height / selectedGroup.height
    const nx = next.x + next.width / 2; const ny = next.y + next.height / 2
    const oldRadians = selectedGroup.rotation * Math.PI / 180
    const nextRadians = next.rotation * Math.PI / 180
    const rotationDelta = nextRadians - oldRadians
    const nodes = document.nodes.map((node) => {
      if (!selectedGroup.nodeIds.includes(node.id)) return node
      const oldTop = objectTop(node, document.height)
      const oldCenterX = node.x + node.width / 2; const oldCenterY = oldTop + node.height / 2
      const localX = (oldCenterX - (selectedGroup.x + selectedGroup.width / 2)) * Math.cos(oldRadians) + (oldCenterY - (selectedGroup.y + selectedGroup.height / 2)) * Math.sin(oldRadians)
      const localY = -(oldCenterX - (selectedGroup.x + selectedGroup.width / 2)) * Math.sin(oldRadians) + (oldCenterY - (selectedGroup.y + selectedGroup.height / 2)) * Math.cos(oldRadians)
      const scaledX = localX * sx; const scaledY = localY * sy
      const centerX = nx + scaledX * Math.cos(nextRadians) - scaledY * Math.sin(nextRadians)
      const centerY = ny + scaledX * Math.sin(nextRadians) + scaledY * Math.cos(nextRadians)
      const width = Math.max(1, node.width * sx); const height = Math.max(1, node.height * sy)
      const x = centerX - width / 2; const top = centerY - height / 2
      const y = node.kind === 'path' || node.kind === 'aiText' ? document.height - top - height : top
      const pathSegments = node.kind === 'path' ? node.pathSegments?.map((segment) => ({ ...segment, points: segment.points.map(([pointX, pointY]) => [x + (pointX - node.x) * sx, document.height - (top + ((document.height - pointY) - oldTop) * sy)]) })) : node.pathSegments
      return { ...node, x, y, width, height, ...(node.kind === 'text' && node.fontSize ? { fontSize: Math.max(1, node.fontSize * sy) } : {}), rotation: node.rotation + (rotationDelta * 180 / Math.PI), ...(node.kind === 'path' ? { pathSegments } : {}) }
    })
    commit({ ...document, nodes, groups: (document.groups ?? []).map((group) => group.id === next.id ? next : group) })
  }
  const reorderGroup = (direction: 'front' | 'back') => {
    if (!selectedGroup || selectedGroup.locked || selectedGroup.nodeIds.some((id) => document.nodes.find((node) => node.id === id)?.locked)) return
    const members = selectedGroup.nodeIds
    const selectedNodes = document.nodes.filter((node) => members.includes(node.id))
    const rest = document.nodes.filter((node) => !members.includes(node.id))
    commit({ ...document, nodes: direction === 'front' ? [...rest, ...selectedNodes] : [...selectedNodes, ...rest] })
  }

  const renderEditorLayers = () => {
    const groups = document.groups ?? []
    const emittedGroups = new Set<string>()
    const renderNodeRow = (node: EditorNode, group?: NodeGroup) => <div key={node.id} className={`layer-row ${selectedIds.includes(node.id) ? 'selected' : ''}`} data-node-id={node.id} style={group ? { paddingLeft: 22 } : undefined} onClick={(event) => { if (event.ctrlKey || event.metaKey) { const next = selectedIds.includes(node.id) ? selectedIds.filter((id) => id !== node.id) : [...selectedIds, node.id]; setSelectedIds(next); setSelectedId(next.at(-1) ?? null); setSelectedGroupId(null) } else { setSelectedIds([node.id]); setSelectedId(node.id); setSelectedGroupId(null) } }}><button className="layer-visibility" title={node.visible ? '숨기기' : '표시하기'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { visible: !node.visible }) }}>{node.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><div className={`layer-thumb thumb-${node.kind}`} style={{ color: node.fill }}><NodeIcon kind={node.kind} /></div><span className="layer-name">{group ? `↳ ${node.name}` : node.name}</span><button className={`layer-lock ${node.locked ? 'locked' : ''}`} title={node.locked ? '잠금 해제' : '잠금'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { locked: !node.locked }) }}><LockKeyhole size={12} /></button></div>
    const renderGroupRow = (group: NodeGroup) => <div key={group.id} className={`layer-row ${selectedGroupId === group.id ? 'selected' : ''}`} data-group-id={group.id} onClick={() => { setSelectedGroupId(group.id); setSelectedId(null); setSelectedIds([]) }}><button className="layer-visibility" title={group.visible ? '숨기기' : '표시하기'} onClick={(event) => { event.stopPropagation(); commit({ ...document, groups: groups.map((item) => item.id === group.id ? { ...item, visible: !item.visible } : item) }) }}>{group.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><div className="layer-thumb">▱</div><span className="layer-name">{group.name}</span><button className={`layer-lock ${group.locked ? 'locked' : ''}`} title={group.locked ? '잠금 해제' : '잠금'} onClick={(event) => { event.stopPropagation(); commit({ ...document, groups: groups.map((item) => item.id === group.id ? { ...item, locked: !item.locked } : item) }) }}><LockKeyhole size={12} /></button></div>
    const rows: React.ReactNode[] = []
    for (const node of [...document.nodes].reverse()) {
      const group = groups.find((item) => item.nodeIds.includes(node.id))
      if (!group) rows.push(renderNodeRow(node))
      else if (!emittedGroups.has(group.id)) {
        emittedGroups.add(group.id)
        rows.push(renderGroupRow(group))
        for (const child of [...document.nodes].reverse()) if (group.nodeIds.includes(child.id)) rows.push(renderNodeRow(child, group))
      }
    }
    return rows
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><span>northstar</span><span className="brand-divider" /><span className="workspace-label">워크스페이스</span></div>
      <div className="document-tab"><span className="doc-dot" />{document.name}<span className="tab-close"><X size={13} /></span></div>
      <div className="top-actions"><button className="icon-button" title="실행 취소" onClick={undo} disabled={!history.length}><Undo2 size={17} /></button><button className="icon-button" title="다시 실행" onClick={redo} disabled={!future.length}><Redo2 size={17} /></button><span className="top-divider" /><button className="button subtle" onClick={() => void open()}><FilePlus2 size={15} /> 열기</button><button className="button primary" onClick={() => void save()} disabled={psdSaveBlocked} title={psdSaveBlocked ? '지원되지 않는 PSD 데이터가 있어 저장할 수 없습니다.' : undefined}><Save size={15} /> {psd ? 'PSD 사본 저장' : '.nbdoc 저장'}</button><div style={{ position: 'relative' }}><button className="button subtle" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}><Download size={15} /> 내보내기</button>{exportOpen && <div className="export-menu" role="menu" aria-label="파일 형식 선택" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 20, minWidth: 210, padding: 6, border: '1px solid #35363a', borderRadius: 8, background: '#1b1c1f', boxShadow: '0 8px 24px #0008' }}>{([['png', 'PNG 이미지'], ['jpeg', 'JPEG 이미지'], ['psd', 'PSD 평면 문서'], ['svg', 'Illustrator용 SVG'], ['pdf', 'PDF 문서 · 평면 이미지'], ['ai', 'Illustrator AI · 사진은 래스터']] as const).map(([format, label]) => <button role="menuitem" key={format} style={{ display: 'block', width: '100%', padding: '9px 10px', border: 0, borderRadius: 5, background: 'transparent', color: '#eee', textAlign: 'left', cursor: 'pointer' }} onClick={() => void exportFile(format)}>{label}</button>)}</div>}</div><button className="avatar">J</button></div>
    </header>
    <div className="subbar"><div className="crumb"><span>내 파일</span><span className="crumb-sep">/</span><strong>{psd?.name ?? document.name}</strong><ChevronDown size={13} /></div><div className="canvas-status" role="status" aria-live="polite"><span className="saved-dot" />{message}<span className="status-divider" />{psd ? `PSD · ${psd.bitDepth}비트` : aiImport ? `AI 가져오기 · PDF ${aiImport.pdfVersion}` : 'NBDOC · RGB · 8비트'}</div></div>
    <div className="workspace">
      <aside className="tool-rail">
        <div className="tool-group"><ToolButton active={tool === 'select'} label="선택" onClick={() => setTool('select')}><MousePointer2 /></ToolButton>{!psd && <><ToolButton active={tool === 'rect'} label="사각형" onClick={() => setTool('rect')}><Square /></ToolButton><ToolButton active={tool === 'ellipse'} label="타원" onClick={() => setTool('ellipse')}><Circle /></ToolButton><ToolButton active={tool === 'text'} label="텍스트" onClick={() => setTool('text')}><Type /></ToolButton><ToolButton active={false} label="이미지 가져오기" onClick={() => void importImage()}><ImagePlus /></ToolButton></>}</div>
        <div className="rail-bottom"><div className="rail-divider" /><button className="rail-action" title="정렬"><AlignLeft size={17} /></button><button className="rail-action" title="그리드"><Grid2X2 size={17} /></button></div>
      </aside>
      <main className="stage-area">
        <div className="canvas-toolbar"><div className="canvas-tools"><button className={tool === 'select' ? 'mini-tool active' : 'mini-tool'} title="선택 도구" onClick={() => setTool('select')}><MousePointer2 size={15} /></button>{!psd && <><span className="mini-separator" /><button className="mini-tool" title="레이어 추가" onClick={() => addNode('rect')}><Square size={14} /></button><button className="mini-tool" title="텍스트 추가" onClick={() => addNode('text')}><Type size={15} /></button><button className="mini-tool" title="이미지 가져오기" onClick={() => void importImage()}><FileImage size={15} /></button></>}</div><div className="canvas-tools"><span className="canvas-dimensions">{psd?.width ?? document.width} × {psd?.height ?? document.height}</span><span className="mini-separator" /><button className="zoom-button" onClick={() => setZoom(Math.max(40, zoom - 10))}>−</button><span className="zoom-value">{zoom}%</span><button className="zoom-button" onClick={() => setZoom(Math.min(120, zoom + 10))}>+</button></div></div>
        <div className={`file-capability ${psd ? 'file-capability-psd' : aiImport ? 'file-capability-ai' : 'file-capability-native'}`} data-testid="file-capability" aria-label="파일 형식 및 편집 범위">
          {psd ? <><strong>PSD · 가져온 원본</strong><span>편집: 레이어 속성 · 픽셀 내용 편집 불가</span><span>저장: {psd.bitDepth !== 8 ? `${psd.bitDepth}비트 파일은 저장 불가` : psdSaveBlocked ? '현재 파일 차단 · 미지원 데이터' : '별도 PSD 사본 · 8비트 RGB만'}</span></> : aiImport ? <><strong>AI · PDF 호환 내용 가져오기</strong><span>편집: 변환된 벡터·ASCII 텍스트</span><span>저장: .nbdoc만 · AI 원본 저장 불가</span></> : <><strong>.nbdoc · Northstar 문서</strong><span>편집 가능 · .nbdoc로 저장</span></>}
        </div>
        {aiImport ? <div className="ai-warning" role="status" data-testid="ai-import-warning"><strong>변환 안내 · AI 원본은 변경되지 않았습니다</strong><span>{aiImport.sourceName}: PDF 호환 내용만 가져왔습니다. {aiImport.limitations}</span></div> : null}
        {psd?.warnings.length ? <details className="psd-warning-list"><summary>PSD 저장 전 확인할 {psd.warnings.length}개 항목</summary><ul>{psd.warnings.map((warning, index) => <li key={`${warning.layerId ?? 'document'}-${index}`}>{warning.message}</li>)}</ul></details> : null}
        <div className="canvas-workspace"><div className="ruler ruler-top"><span>0</span><span>240</span><span>480</span><span>720</span><span>960</span><span>1200</span><span>1440</span></div><div className="ruler ruler-left"><span>0</span><span>160</span><span>320</span><span>480</span><span>640</span><span>800</span><span>960</span></div>
          <div className="canvas-frame" style={{ width: `${Math.round((psd?.width ?? document.width) * zoom / 100)}px`, height: `${Math.round((psd?.height ?? document.height) * zoom / 100)}px` }}>{psd ? <div className="psd-artboard" data-testid="psd-artboard">{renderPsdLayers(psd.layers, psd.width, psd.height, psdEdits, selectedPsdId, setSelectedPsdId)}</div> : <svg ref={svgRef} data-testid={aiImport ? 'ai-artboard' : 'editor-artboard'} viewBox={`0 0 ${document.width} ${document.height}`} onPointerDown={onCanvasDown} onPointerMove={(event) => { if (dragRef.current && !(event.target as SVGElement).closest('[data-node]')) onNodeMove(event) }} onPointerUp={onNodeUp} onPointerCancel={onNodeUp} onLostPointerCapture={onNodeUp} className="artboard" style={{ background: document.background }}>
            {document.nodes.map((node) => { const group = (document.groups ?? []).find((candidate) => candidate.nodeIds.includes(node.id)); return node.visible && group?.visible !== false && <g key={node.id} data-node="true" data-node-id={node.id} opacity={node.opacity / 100} transform={`rotate(${node.rotation} ${node.x + node.width / 2} ${objectTop(node, document.height) + node.height / 2})`} onPointerDown={(event) => onNodeDown(event, node)} onPointerMove={onNodeMove} onPointerUp={onNodeUp} onPointerCancel={onNodeUp} onLostPointerCapture={onNodeUp}>
              {node.kind === 'rect' && <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="7" fill={node.fill} />}
              {node.kind === 'ellipse' && <ellipse cx={node.x + node.width / 2} cy={node.y + node.height / 2} rx={node.width / 2} ry={node.height / 2} fill={node.fill} />}
              {node.kind === 'text' && <text x={node.textAlign === 'middle' ? node.x + node.width / 2 : node.textAlign === 'end' ? node.x + node.width : node.x} y={node.y + (node.fontSize ?? 40)} textLength={node.width} lengthAdjust="spacingAndGlyphs" fontSize={node.fontSize ?? 40} fontFamily={node.fontFamily || undefined} fontWeight={node.fontWeight ?? 600} textAnchor={node.textAlign ?? 'start'} fill={node.fill}>{node.text}</text>}
              {node.kind === 'aiText' && <text x={node.x} y={document.height - node.y} fontSize={node.fontSize ?? 12} fontFamily="Arial, sans-serif" fill={node.fill}>{node.text}</text>}
              {node.kind === 'path' && <path data-canvas-path="true" d={pathToSvg(node.pathSegments ?? [], document.height, ['s', 'b', 'b*'].includes(node.pathPaint ?? '') )} fill={['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(node.pathPaint ?? '') ? node.fill : 'none'} fillRule={['f*', 'B*', 'b*'].includes(node.pathPaint ?? '') ? 'evenodd' : 'nonzero'} stroke={['S', 's', 'B', 'B*', 'b', 'b*'].includes(node.pathPaint ?? '') ? node.fill : 'none'} strokeWidth="1" strokeLinecap="butt" strokeLinejoin="miter" pointerEvents="visiblePainted" />}
              {node.kind === 'image' && node.src && <image href={node.src} x={node.x} y={node.y} width={node.width} height={node.height} preserveAspectRatio="xMidYMid slice" />}
              {selectedIds.includes(node.id) && !selectedGroup && <rect className="selection-outline" x={node.x - 2} y={(node.kind === 'path' ? document.height - node.y - node.height : node.kind === 'aiText' ? document.height - node.y - node.height : node.y) - 2} width={node.width + 4} height={node.height + 4} fill="none" stroke="#7277ff" strokeWidth={2} strokeDasharray="7 4" pointerEvents="none" />}
            </g>})}
            {selectedGroup && <rect data-testid="group-selection-outline" x={selectedGroup.x} y={selectedGroup.y} width={selectedGroup.width} height={selectedGroup.height} transform={`rotate(${selectedGroup.rotation} ${selectedGroup.x + selectedGroup.width / 2} ${selectedGroup.y + selectedGroup.height / 2})`} fill="none" stroke="#a18ad3" strokeWidth={3} strokeDasharray="9 5" pointerEvents="none" />}
            {!document.nodes.length && <g pointerEvents="none"><text x="720" y="450" textAnchor="middle" fill="#8d8d91" fontSize="27" fontWeight="600">아이디어를 캔버스에 담아보세요</text><text x="720" y="488" textAnchor="middle" fill="#a5a5a8" fontSize="17">왼쪽 도구를 선택하고 캔버스를 클릭해 오브젝트를 추가하세요</text></g>}
          </svg>}</div>
        </div><footer className="bottom-bar"><div><span className="bottom-indicator" />{psd ? `${countPsdLayers(psd.layers)}개 PSD 레이어` : `${document.nodes.length}개 오브젝트`}<span className="bottom-separator">·</span>{psd ? `${psd.width} × ${psd.height}` : '1440 × 960'} px</div><div><span className="bottom-tip">드래그하여 이동</span><span className="bottom-separator">·</span><button className="bottom-fit" onClick={() => setZoom(82)}>화면에 맞춤</button></div></footer>
      </main>
      <aside className="right-sidebar">
        <section className="panel layers-panel"><div className="panel-heading"><div><Layers size={15} /><h2>레이어</h2><span className="count-pill">{psd ? countPsdLayers(psd.layers) : document.nodes.length}</span></div>{!psd && <button className="panel-menu" onClick={() => addNode('rect')} title="레이어 추가">+</button>}</div>
          {!psd && <div className="group-actions"><button title="선택 항목 그룹화" onClick={groupSelection} disabled={!canGroupSelection}>그룹화</button><button title="그룹 해제" onClick={ungroupSelection} disabled={!selectedGroup}>그룹 해제</button></div>}
          <div className="layer-list">{psd ? renderPsdRows(psd.layers, selectedPsdId, setSelectedPsdId, updatePsdLayer) : <>{document.nodes.length === 0 && !document.groups?.length && <div className="empty-layers">레이어가 아직 없습니다<br /><span>캔버스에 오브젝트를 추가해 보세요</span></div>}{renderEditorLayers()}</>}</div>
        </section>
        <section className="panel properties-panel"><div className="panel-heading"><div><span className="properties-icon">◈</span><h2>속성</h2></div>{effectivePsdLayer ? <span className="selected-kind">{effectivePsdLayer.kind.toUpperCase()}</span> : selected && <span className="selected-kind">{selected.kind.toUpperCase()}</span>}</div>
          {!selected && !effectivePsdLayer && !selectedGroup ? <div className="empty-properties"><div className="empty-cursor"><MousePointer2 size={17} /></div><strong>오브젝트를 선택하세요</strong><span>캔버스 또는 레이어 패널에서<br />오브젝트를 선택하면 속성을 편집할 수 있어요</span></div> : selectedGroup ? <div className="property-content" data-testid="group-properties"><label className="field-label">그룹 이름</label><input className="text-input" value={selectedGroup.name} onChange={(event) => commit({ ...document, groups: (document.groups ?? []).map((group) => group.id === selectedGroup.id ? { ...group, name: event.target.value } : group) })} /><label className="field-label position-label">위치</label><div className="field-grid"><NumberField label="X" value={selectedGroup.x} onChange={(event) => transformGroup('x', Number(event.target.value))} /><NumberField label="Y" value={selectedGroup.y} onChange={(event) => transformGroup('y', Number(event.target.value))} /></div><label className="field-label position-label">크기</label><div className="field-grid"><NumberField label="W" value={selectedGroup.width} onChange={(event) => transformGroup('width', Number(event.target.value))} /><NumberField label="H" value={selectedGroup.height} onChange={(event) => transformGroup('height', Number(event.target.value))} /></div><div className="property-row"><label>회전</label><div className="number-control"><input aria-label="회전" type="number" step="0.1" value={selectedGroup.rotation} onChange={(event) => transformGroup('rotation', Number(event.target.value))} /><span>°</span></div></div><div className="property-row"><label>표시</label><button className="layer-visibility" onClick={() => commit({ ...document, groups: (document.groups ?? []).map((group) => group.id === selectedGroup.id ? { ...group, visible: !group.visible } : group) })}>{selectedGroup.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button><button className="layer-lock" onClick={() => commit({ ...document, groups: (document.groups ?? []).map((group) => group.id === selectedGroup.id ? { ...group, locked: !group.locked } : group) })}><LockKeyhole size={14} /></button></div><div className="layer-order"><button onClick={() => reorderGroup('front')}><ArrowUp size={13} />앞으로</button><button onClick={() => reorderGroup('back')}><ArrowDown size={13} />뒤로</button></div></div> : effectivePsdLayer ? <div className="property-content">
            <label className="field-label">이름</label><input className="text-input" aria-label="레이어 이름" value={effectivePsdLayer.name} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { name: event.target.value })} />
            <label className="field-label position-label">위치</label><div className="field-grid"><NumberField label="X" value={effectivePsdLayer.left} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { left: Number(event.target.value) })} /><NumberField label="Y" value={effectivePsdLayer.top} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { top: Number(event.target.value) })} /></div>
            <div className="property-row position-label"><label>표시</label><button className="layer-visibility" aria-label="레이어 표시 전환" title={effectivePsdLayer.visible ? '숨기기' : '표시하기'} onClick={() => updatePsdLayer(effectivePsdLayer.id, { visible: !effectivePsdLayer.visible })}>{effectivePsdLayer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>
            <div className="property-row opacity-row"><label>불투명도</label><span className="opacity-number">{Math.round(effectivePsdLayer.opacity * 100)}%</span></div><input aria-label="레이어 불투명도" className="opacity-slider" type="range" min="0" max="100" value={Math.round(effectivePsdLayer.opacity * 100)} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { opacity: Number(event.target.value) / 100 })} />
            {psd?.warnings.length ? <div className="psd-warning" role="status">저장 전 확인: {psd.warnings.length}개 항목<br />{psd.warnings.slice(0, 3).map((warning) => warning.message).join(' ')}</div> : null}
          </div> : selected ? <div className="property-content">
            <label className="field-label">이름</label><input className="text-input" value={selected.name} onChange={(event) => updateNode(selected.id, { name: event.target.value })} />
            <label className="field-label position-label">위치</label><div className="field-grid"><NumberField label="X" value={selected.x} onChange={(event) => editDimension('x', event)} /><NumberField label="Y" value={selected.y} onChange={(event) => editDimension('y', event)} /></div>
            {selected.kind !== 'aiText' && <><label className="field-label position-label">크기</label><div className="field-grid"><NumberField label="W" value={selected.width} onChange={(event) => editDimension('width', event)} /><NumberField label="H" value={selected.height} onChange={(event) => editDimension('height', event)} /></div></>}
            <div className="property-row rotation-row"><label>회전</label><div className="number-control"><input aria-label="회전" type="number" step="0.1" value={selected.rotation} onChange={(event) => editDimension('rotation', event)} /><span>°</span></div></div>
            {(selected.kind === 'text' || selected.kind === 'aiText') && <><label className="field-label position-label">텍스트</label><textarea aria-label="텍스트 내용" className="text-input text-area" value={selected.text ?? ''} onChange={(event) => updateNode(selected.id, { text: event.target.value })} /><div className="property-row"><label>크기</label><div className="number-control"><input aria-label="글꼴 크기" type="number" min="1" step="0.1" value={selected.fontSize ?? 40} onChange={(event) => updateNode(selected.id, { fontSize: Number(event.target.value) })} /><span>{selected.kind === 'aiText' ? 'pt' : 'px'}</span></div></div>{selected.kind === 'text' && <><label className="field-label">글꼴</label><input aria-label="글꼴" className="text-input" value={selected.fontFamily ?? ''} placeholder="기본 글꼴" onChange={(event) => updateNode(selected.id, { fontFamily: event.target.value })} /><div className="field-grid"><NumberField label="굵기" value={selected.fontWeight ?? 600} onChange={(event) => updateNode(selected.id, { fontWeight: Number(event.target.value) })} /><label className="number-field"><span>정렬</span><select aria-label="텍스트 정렬" value={selected.textAlign ?? 'start'} onChange={(event) => updateNode(selected.id, { textAlign: event.target.value as 'start' | 'middle' | 'end' })}><option value="start">왼쪽</option><option value="middle">가운데</option><option value="end">오른쪽</option></select></label></div></>}</>}
            {selected.kind === 'path' && <><label className="field-label position-label">경로 세그먼트 (JSON)</label><textarea key={selected.id} aria-label="벡터 경로" className="text-input text-area path-editor" defaultValue={JSON.stringify(selected.pathSegments ?? [], null, 2)} onBlur={(event) => { try { const segments: unknown = JSON.parse(event.currentTarget.value); if (isValidPathSegments(segments)) updateNode(selected.id, { pathSegments: segments }); else setMessage('경로 JSON 형식을 확인해 주세요') } catch { setMessage('경로 JSON 형식을 확인해 주세요') } }} /></>}
            {selected.kind !== 'image' && <><label className="field-label position-label">채우기</label><div className="color-control"><span className="color-preview" style={{ background: selected.fill }} /><input aria-label="색상 코드" value={selected.fill} onChange={(event) => updateNode(selected.id, { fill: event.target.value })} /><input aria-label="색상 선택" type="color" value={selected.fill} onChange={(event) => updateNode(selected.id, { fill: event.target.value })} /></div></>}
            <div className="property-row opacity-row"><label>불투명도</label><span className="opacity-number">{selected.opacity}%</span></div><input className="opacity-slider" type="range" min="0" max="100" value={selected.opacity} onChange={(event) => updateNode(selected.id, { opacity: Number(event.target.value) })} />
            <div className="swatches">{palettes.map((color) => <button key={color} className={`swatch ${selected.fill === color ? 'chosen' : ''}`} style={{ background: color }} title={color} onClick={() => updateNode(selected.id, { fill: color })} />)}</div>
            <div className="layer-order"><button onClick={() => reorder(selected.id, 1)}><ArrowUp size={13} />앞으로</button><button onClick={() => reorder(selected.id, -1)}><ArrowDown size={13} />뒤로</button></div>
          </div> : null}
        </section>
      </aside>
    </div>
  </div>
}

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) { return <button className={`tool-button ${active ? 'active' : ''}`} title={label} aria-label={label} onClick={onClick}>{children}</button> }
function NodeIcon({ kind }: { kind: NodeKind }) { return kind === 'ellipse' ? <Circle size={15} /> : kind === 'text' || kind === 'aiText' ? <Type size={15} /> : kind === 'image' ? <FileImage size={15} /> : <Square size={15} /> }
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (event: ChangeEvent<HTMLInputElement>) => void }) { return <label className="number-field"><span>{label}</span><input aria-label={label} type="number" step="0.1" value={value} onChange={onChange} /></label> }

function objectTop(node: EditorNode, documentHeight: number): number {
  return node.kind === 'path' || node.kind === 'aiText' ? documentHeight - node.y - node.height : node.y
}

function createExportSvg(source: SVGSVGElement | null, width: number, height: number, background: string): string {
  if (!source) throw new Error('내보낼 캔버스를 찾지 못했습니다.')
  const svg = source.cloneNode(true) as SVGSVGElement
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const backdrop = window.document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  backdrop.setAttribute('width', String(width)); backdrop.setAttribute('height', String(height)); backdrop.setAttribute('fill', background)
  svg.insertBefore(backdrop, svg.firstChild)
  svg.querySelectorAll('.selection-outline,[data-testid="group-selection-outline"]').forEach((element) => element.remove())
  if (!svg.querySelector('[data-node]')) svg.querySelectorAll('g').forEach((element) => element.remove())
  return new XMLSerializer().serializeToString(svg)
}

function createPsdSvg(layers: PsdLayerView[], width: number, height: number, edits: Record<string, LayerChanges>): string {
  const serialize = (items: PsdLayerView[], parentVisible = true): string => items.map((original) => {
    const layer = { ...original, ...edits[original.id] }
    if (!parentVisible || !layer.visible) return ''
    const image = layer.kind === 'raster' ? pixelDataUrl(layer) : undefined
    const pixels = layer.pixels
    const item = image && pixels ? `<image href="${image}" x="${layer.left}" y="${layer.top}" width="${pixels.width}" height="${pixels.height}" opacity="${layer.opacity}"/>` : ''
    return `${item}${layer.children ? serialize(layer.children, true) : ''}`
  }).reverse().join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${serialize(layers)}</svg>`
}

function getObjectsBounds(nodes: EditorNode[], documentHeight: number): Pick<NodeGroup, 'x' | 'y' | 'width' | 'height'> {
  const corners = nodes.flatMap((node) => {
    const top = objectTop(node, documentHeight)
    const centerX = node.x + node.width / 2; const centerY = top + node.height / 2
    const radians = node.rotation * Math.PI / 180
    return [[node.x, top], [node.x + node.width, top], [node.x, top + node.height], [node.x + node.width, top + node.height]].map(([x, y]) => {
      const dx = x - centerX; const dy = y - centerY
      return { x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians), y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians) }
    })
  })
  const left = Math.min(...corners.map((point) => point.x)); const top = Math.min(...corners.map((point) => point.y))
  const right = Math.max(...corners.map((point) => point.x)); const bottom = Math.max(...corners.map((point) => point.y))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

function pathToSvg(segments: NonNullable<EditorNode['pathSegments']>, height: number, closeForPaint: boolean): string {
  const commands = segments.map((segment) => {
    if (segment.op === 'Z') return 'Z'
    const points = segment.points.map(([x, y]) => `${x} ${height - y}`).join(' ')
    return `${segment.op} ${points}`
  })
  if (closeForPaint && commands.length) commands.push('Z')
  return commands.join(' ')
}

function findPsdLayer(layers: PsdLayerView[], id: string | null): PsdLayerView | null {
  if (!id) return null
  for (const layer of layers) {
    if (layer.id === id) return layer
    const nested = layer.children && findPsdLayer(layer.children, id)
    if (nested) return nested
  }
  return null
}

function hasPsdSaveBlocker(psd: PsdEditorDocument | null): boolean {
  return Boolean(psd?.warnings.some((warning) => /saving.*blocked/i.test(warning.message)))
}

function patchPsdTree(layers: PsdLayerView[], id: string, changes: LayerChanges): PsdLayerView[] {
  return layers.map((layer) => layer.id === id
    ? { ...layer, ...changes }
    : layer.children ? { ...layer, children: patchPsdTree(layer.children, id, changes) } : layer)
}

function countPsdLayers(layers: PsdLayerView[]): number {
  return layers.reduce((count, layer) => count + 1 + (layer.children ? countPsdLayers(layer.children) : 0), 0)
}

function renderPsdRows(layers: PsdLayerView[], selectedId: string | null, select: (id: string) => void, update: (id: string, changes: LayerChanges) => void, depth = 0): React.ReactNode {
  return layers.map((layer) => <React.Fragment key={layer.id}>
    <div className={`layer-row ${selectedId === layer.id ? 'selected' : ''}`} style={{ paddingLeft: `${5 + depth * 14}px` }} onClick={() => select(layer.id)}>
      <button className="layer-visibility" title={layer.visible ? '숨기기' : '표시하기'} aria-label={`${layer.name} 표시 전환`} onClick={(event) => { event.stopPropagation(); update(layer.id, { visible: !layer.visible }) }}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
      <div className="layer-thumb thumb-image">{layer.children ? '▰' : <FileImage size={14} />}</div><span className="layer-name" title={`${layer.kind} · ${layer.id}`}>{layer.name || '(이름 없음)'}</span><span className="psd-layer-kind">{layer.kind === 'group' ? '그룹' : ''}</span>
    </div>
    {layer.children && renderPsdRows(layer.children, selectedId, select, update, depth + 1)}
  </React.Fragment>)
}

function pixelDataUrl(layer: PsdLayerView): string | undefined {
  if (!layer.pixels || !(layer.pixels.data instanceof Uint8Array || layer.pixels.data instanceof Uint8ClampedArray)) return undefined
  const { width, height } = layer.pixels
  if (layer.pixels.data.length !== width * height * 4) return undefined
  const canvas = window.document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return undefined
  context.putImageData(new ImageData(new Uint8ClampedArray(layer.pixels.data), width, height), 0, 0)
  return canvas.toDataURL('image/png')
}

function renderPsdLayers(layers: PsdLayerView[], width: number, height: number, edits: Record<string, LayerChanges>, selectedId: string | null, select: (id: string) => void, parentVisible = true): React.ReactNode {
  return [...layers].reverse().map((original) => {
    const layer = { ...original, ...edits[original.id] }
    const visible = parentVisible && layer.visible
    const image = layer.kind === 'raster' ? pixelDataUrl(layer) : undefined
    return <React.Fragment key={layer.id}>
      {image && <img className={`psd-layer-image ${selectedId === layer.id ? 'selected-psd-layer' : ''}`} alt={layer.name} draggable={false} src={image} onClick={() => select(layer.id)} style={{ display: visible ? undefined : 'none', left: `${layer.left / width * 100}%`, top: `${layer.top / height * 100}%`, width: `${(layer.pixels?.width ?? 0) / width * 100}%`, height: `${(layer.pixels?.height ?? 0) / height * 100}%`, opacity: layer.opacity }} />}
      {layer.children && renderPsdLayers(layer.children, width, height, edits, selectedId, select, visible)}
    </React.Fragment>
  })
}
