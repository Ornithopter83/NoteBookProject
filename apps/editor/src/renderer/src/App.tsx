import React, { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { AlignLeft, ArrowDown, ArrowUp, ChevronDown, Circle, Eye, EyeOff, FileImage, FilePlus2, Grid2X2, ImagePlus, Layers, LockKeyhole, MousePointer2, Redo2, Save, Square, Type, Undo2, X } from 'lucide-react'
import { cloneDocument, createDocument, type EditorDocument, type EditorNode, type NodeKind } from '../../shared/document'
import type { PsdEditorDocument } from '../../preload'
import type { LayerChanges, PsdLayerView } from '@northstar/psd-bridge'

type Tool = 'select' | 'rect' | 'ellipse' | 'text'
const palettes = ['#f97352', '#f7b955', '#b5ca74', '#62b7a6', '#6797d3', '#a18ad3', '#ed8ca2', '#252629']
const makeId = () => `layer-${Math.random().toString(36).slice(2, 9)}`

export default function App() {
  const [document, setDocument] = useState<EditorDocument>(() => createDocument())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(82)
  const [history, setHistory] = useState<EditorDocument[]>([])
  const [future, setFuture] = useState<EditorDocument[]>([])
  const [message, setMessage] = useState('모든 변경 사항이 저장되었습니다')
  const [psd, setPsd] = useState<PsdEditorDocument | null>(null)
  const [psdEdits, setPsdEdits] = useState<Record<string, LayerChanges>>({})
  const [selectedPsdId, setSelectedPsdId] = useState<string | null>(null)
  const [aiImport, setAiImport] = useState<{ pdfVersion: string; sourceName: string; limitations: string } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: string; x: number; y: number; startX: number; startY: number; before: EditorDocument } | null>(null)
  const selected = document.nodes.find((node) => node.id === selectedId) ?? null
  const selectedPsd = psd ? findPsdLayer(psd.layers, selectedPsdId) : null
  const effectivePsdLayer = selectedPsd ? { ...selectedPsd, ...psdEdits[selectedPsd.id] } : null

  const commit = useCallback((next: EditorDocument) => {
    setHistory((items) => [...items.slice(-49), cloneDocument(document)])
    setFuture([])
    setDocument(next)
    setMessage('저장되지 않은 변경 사항')
  }, [document])

  const updateNode = (id: string, patch: Partial<EditorNode>) => commit({ ...document, nodes: document.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) })
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
    const node: EditorNode = { id: makeId(), kind, name: `${kind === 'rect' ? '사각형' : kind === 'ellipse' ? '타원' : kind === 'text' ? '텍스트' : '이미지'} ${index}`, x, y, width: kind === 'text' ? 330 : kind === 'image' ? 260 : 240, height: kind === 'text' ? 76 : kind === 'image' ? 190 : 180, fill: kind === 'text' ? '#252629' : palettes[(document.nodes.length + 1) % palettes.length], opacity: 100, rotation: 0, visible: true, locked: false, ...(kind === 'text' ? { text: '새로운 아이디어', fontSize: 40 } : {}), ...(src ? { src } : {}) }
    commit({ ...document, nodes: [...document.nodes, node] })
    setSelectedId(node.id)
    setTool('select')
  }

  const save = async () => {
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
  const open = async () => {
    try {
      const result = await window.northstar.openDocument()
      if (result) {
        setSelectedId(null); setSelectedPsdId(null); setHistory([]); setFuture([]); setPsdEdits({})
        if (result.psd) { setAiImport(null); setPsd(result.psd); setDocument(createDocument()); setMessage(`PSD 열기 · ${result.psd.warnings.length}개 확인 사항`) }
        else if (result.document) { setPsd(null); setAiImport(result.aiImport ?? null); setDocument(result.document); setMessage(result.aiImport ? `AI 가져오기 · PDF ${result.aiImport.pdfVersion}` : '문서를 열었습니다') }
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : '문서를 열지 못했습니다') }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
      if (event.key === 'Escape') setTool('select')
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        commit({ ...document, nodes: document.nodes.filter((node) => node.id !== selectedId) }); setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commit, document, redo, save, selectedId, undo])

  const canvasPoint = (event: React.PointerEvent<SVGElement>) => {
    const box = svgRef.current!.getBoundingClientRect()
    return { x: (event.clientX - box.left) * document.width / box.width, y: (event.clientY - box.top) * document.height / box.height }
  }
  const onCanvasDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as SVGElement).closest('[data-node]')) return
    const point = canvasPoint(event)
    if (tool !== 'select') { addNode(tool, point.x, point.y); return }
    setSelectedId(null)
  }
  const onNodeDown = (event: React.PointerEvent<SVGElement>, node: EditorNode) => {
    event.stopPropagation()
    setSelectedId(node.id)
    if (tool !== 'select' || node.locked) return
    const point = canvasPoint(event)
    dragRef.current = { id: node.id, x: point.x, y: point.y, startX: node.x, startY: node.y, before: cloneDocument(document) }
    ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
  }
  const onNodeMove = (event: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const point = canvasPoint(event)
    const dx = point.x - drag.x; const dy = point.y - drag.y
    setDocument((current) => ({ ...current, nodes: current.nodes.map((node) => node.id !== drag.id ? node : node.kind === 'path'
      ? { ...node, x: node.x + dx, y: node.y - dy, pathSegments: node.pathSegments?.map((segment) => ({ ...segment, points: segment.points.map(([x, y]) => [x + dx, y - dy]) })) }
      : { ...node, x: Math.round(drag.startX + dx), y: Math.round(drag.startY + (node.kind === 'aiText' ? -dy : dy)) }) }))
  }
  const onNodeUp = () => {
    if (!dragRef.current) return
    setHistory((items) => [...items.slice(-49), dragRef.current!.before]); setFuture([]); dragRef.current = null; setMessage('저장되지 않은 변경 사항')
  }

  const importImage = async () => { const src = await window.northstar.importImage(); if (src) addNode('image', undefined, undefined, src) }
  const editDimension = (key: 'x' | 'y' | 'width' | 'height' | 'rotation', event: ChangeEvent<HTMLInputElement>) => {
    if (!selected) return
    const value = Number(event.target.value)
    if (selected.kind === 'path' && (key === 'x' || key === 'y')) {
      const delta = value - selected[key]
      updateNode(selected.id, { [key]: value, pathSegments: selected.pathSegments?.map((segment) => ({ ...segment, points: segment.points.map(([x, y]) => [x + (key === 'x' ? delta : 0), y + (key === 'y' ? delta : 0)]) })) })
    } else updateNode(selected.id, { [key]: value })
  }
  const reorder = (id: string, direction: -1 | 1) => {
    const index = document.nodes.findIndex((node) => node.id === id); const nextIndex = Math.max(0, Math.min(document.nodes.length - 1, index + direction))
    if (index === nextIndex) return
    const nodes = [...document.nodes]; [nodes[index], nodes[nextIndex]] = [nodes[nextIndex], nodes[index]]; commit({ ...document, nodes })
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><span>northstar</span><span className="brand-divider" /><span className="workspace-label">워크스페이스</span></div>
      <div className="document-tab"><span className="doc-dot" />{document.name}<span className="tab-close"><X size={13} /></span></div>
      <div className="top-actions"><button className="icon-button" title="실행 취소" onClick={undo} disabled={!history.length}><Undo2 size={17} /></button><button className="icon-button" title="다시 실행" onClick={redo} disabled={!future.length}><Redo2 size={17} /></button><span className="top-divider" /><button className="button subtle" onClick={() => void open()}><FilePlus2 size={15} /> 열기</button><button className="button primary" onClick={() => void save()}><Save size={15} /> 저장</button><button className="avatar">J</button></div>
    </header>
    <div className="subbar"><div className="crumb"><span>내 파일</span><span className="crumb-sep">/</span><strong>{psd?.name ?? document.name}</strong><ChevronDown size={13} /></div><div className="canvas-status"><span className="saved-dot" />{message}<span className="status-divider" />{psd ? `PSD · ${psd.bitDepth}비트` : 'RGB · 8비트'}</div></div>
    <div className="workspace">
      <aside className="tool-rail">
        <div className="tool-group"><ToolButton active={tool === 'select'} label="선택" onClick={() => setTool('select')}><MousePointer2 /></ToolButton>{!psd && <><ToolButton active={tool === 'rect'} label="사각형" onClick={() => setTool('rect')}><Square /></ToolButton><ToolButton active={tool === 'ellipse'} label="타원" onClick={() => setTool('ellipse')}><Circle /></ToolButton><ToolButton active={tool === 'text'} label="텍스트" onClick={() => setTool('text')}><Type /></ToolButton><ToolButton active={false} label="이미지 가져오기" onClick={() => void importImage()}><ImagePlus /></ToolButton></>}</div>
        <div className="rail-bottom"><div className="rail-divider" /><button className="rail-action" title="정렬"><AlignLeft size={17} /></button><button className="rail-action" title="그리드"><Grid2X2 size={17} /></button></div>
      </aside>
      <main className="stage-area">
        <div className="canvas-toolbar"><div className="canvas-tools"><button className={tool === 'select' ? 'mini-tool active' : 'mini-tool'} title="선택 도구" onClick={() => setTool('select')}><MousePointer2 size={15} /></button>{!psd && <><span className="mini-separator" /><button className="mini-tool" title="레이어 추가" onClick={() => addNode('rect')}><Square size={14} /></button><button className="mini-tool" title="텍스트 추가" onClick={() => addNode('text')}><Type size={15} /></button><button className="mini-tool" title="이미지 가져오기" onClick={() => void importImage()}><FileImage size={15} /></button></>}</div><div className="canvas-tools"><span className="canvas-dimensions">{psd?.width ?? document.width} × {psd?.height ?? document.height}</span><span className="mini-separator" /><button className="zoom-button" onClick={() => setZoom(Math.max(40, zoom - 10))}>−</button><span className="zoom-value">{zoom}%</span><button className="zoom-button" onClick={() => setZoom(Math.min(120, zoom + 10))}>+</button></div></div>
        {aiImport ? <div className="ai-warning" role="status" data-testid="ai-import-warning"><strong>AI 가져오기 · 원본은 변경되지 않습니다</strong><span>{aiImport.sourceName}에서 PDF 호환 벡터와 ASCII 텍스트를 .nbdoc 문서로 변환했습니다. {aiImport.limitations} Illustrator 전용 글꼴 정보와 메타데이터는 보존되지 않으며 네이티브 AI 저장은 지원하지 않습니다.</span></div> : null}
        {psd?.warnings.length ? <details className="psd-warning-list"><summary>PSD 저장 전 확인할 {psd.warnings.length}개 항목</summary><ul>{psd.warnings.map((warning, index) => <li key={`${warning.layerId ?? 'document'}-${index}`}>{warning.message}</li>)}</ul></details> : null}
        <div className="canvas-workspace"><div className="ruler ruler-top"><span>0</span><span>240</span><span>480</span><span>720</span><span>960</span><span>1200</span><span>1440</span></div><div className="ruler ruler-left"><span>0</span><span>160</span><span>320</span><span>480</span><span>640</span><span>800</span><span>960</span></div>
          <div className="canvas-frame" style={{ width: `${Math.round((psd?.width ?? document.width) * zoom / 100)}px`, height: `${Math.round((psd?.height ?? document.height) * zoom / 100)}px` }}>{psd ? <div className="psd-artboard" data-testid="psd-artboard">{renderPsdLayers(psd.layers, psd.width, psd.height, psdEdits, selectedPsdId, setSelectedPsdId)}</div> : <svg ref={svgRef} data-testid={aiImport ? 'ai-artboard' : 'editor-artboard'} viewBox={`0 0 ${document.width} ${document.height}`} onPointerDown={onCanvasDown} onPointerMove={(event) => { if (dragRef.current) onNodeMove(event) }} onPointerUp={onNodeUp} onPointerCancel={onNodeUp} className="artboard" style={{ background: document.background }}>
            {document.nodes.map((node) => node.visible && <g key={node.id} data-node="true" opacity={node.opacity / 100} transform={`rotate(${node.rotation} ${node.x + node.width / 2} ${node.y + node.height / 2})`} onPointerDown={(event) => onNodeDown(event, node)} onPointerMove={onNodeMove} onPointerUp={onNodeUp}>
              {node.kind === 'rect' && <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="7" fill={node.fill} />}
              {node.kind === 'ellipse' && <ellipse cx={node.x + node.width / 2} cy={node.y + node.height / 2} rx={node.width / 2} ry={node.height / 2} fill={node.fill} />}
              {node.kind === 'text' && <text x={node.x} y={node.y + (node.fontSize ?? 40)} fontSize={node.fontSize ?? 40} fontWeight="600" fill={node.fill}>{node.text}</text>}
              {node.kind === 'aiText' && <text x={node.x} y={document.height - node.y} fontSize={node.fontSize ?? 12} fontFamily="Arial, sans-serif" fill={node.fill}>{node.text}</text>}
              {node.kind === 'path' && <path d={pathToSvg(node.pathSegments ?? [], document.height, ['s', 'b', 'b*'].includes(node.pathPaint ?? '') )} fill={['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(node.pathPaint ?? '') ? node.fill : 'none'} fillRule={['f*', 'B*', 'b*'].includes(node.pathPaint ?? '') ? 'evenodd' : 'nonzero'} stroke={['S', 's', 'B', 'B*', 'b', 'b*'].includes(node.pathPaint ?? '') ? node.fill : 'none'} strokeWidth="1" strokeLinecap="butt" strokeLinejoin="miter" />}
              {node.kind === 'image' && node.src && <image href={node.src} x={node.x} y={node.y} width={node.width} height={node.height} preserveAspectRatio="xMidYMid slice" />}
              {selectedId === node.id && <rect className="selection-outline" x={node.x - 2} y={(node.kind === 'path' ? document.height - node.y - node.height : node.kind === 'aiText' ? document.height - node.y - node.height : node.y) - 2} width={node.width + 4} height={node.height + 4} fill="none" stroke="#7277ff" strokeWidth={2} strokeDasharray="7 4" pointerEvents="none" />}
            </g>)}
            {!document.nodes.length && <g pointerEvents="none"><text x="720" y="450" textAnchor="middle" fill="#8d8d91" fontSize="27" fontWeight="600">아이디어를 캔버스에 담아보세요</text><text x="720" y="488" textAnchor="middle" fill="#a5a5a8" fontSize="17">왼쪽 도구를 선택하고 캔버스를 클릭해 오브젝트를 추가하세요</text></g>}
          </svg>}</div>
        </div><footer className="bottom-bar"><div><span className="bottom-indicator" />{psd ? `${countPsdLayers(psd.layers)}개 PSD 레이어` : `${document.nodes.length}개 오브젝트`}<span className="bottom-separator">·</span>{psd ? `${psd.width} × ${psd.height}` : '1440 × 960'} px</div><div><span className="bottom-tip">드래그하여 이동</span><span className="bottom-separator">·</span><button className="bottom-fit" onClick={() => setZoom(82)}>화면에 맞춤</button></div></footer>
      </main>
      <aside className="right-sidebar">
        <section className="panel layers-panel"><div className="panel-heading"><div><Layers size={15} /><h2>레이어</h2><span className="count-pill">{psd ? countPsdLayers(psd.layers) : document.nodes.length}</span></div>{!psd && <button className="panel-menu" onClick={() => addNode('rect')} title="레이어 추가">+</button>}</div>
          <div className="layer-list">{psd ? renderPsdRows(psd.layers, selectedPsdId, setSelectedPsdId, updatePsdLayer) : <>{document.nodes.length === 0 && <div className="empty-layers">레이어가 아직 없습니다<br /><span>캔버스에 오브젝트를 추가해 보세요</span></div>}{[...document.nodes].reverse().map((node) => <div key={node.id} className={`layer-row ${selectedId === node.id ? 'selected' : ''}`} onClick={() => setSelectedId(node.id)}><button className="layer-visibility" title={node.visible ? '숨기기' : '표시하기'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { visible: !node.visible }) }}>{node.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><div className={`layer-thumb thumb-${node.kind}`} style={{ color: node.fill }}><NodeIcon kind={node.kind} /></div><span className="layer-name">{node.name}</span><button className={`layer-lock ${node.locked ? 'locked' : ''}`} title={node.locked ? '잠금 해제' : '잠금'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { locked: !node.locked }) }}><LockKeyhole size={12} /></button></div>)}</>}</div>
        </section>
        <section className="panel properties-panel"><div className="panel-heading"><div><span className="properties-icon">◈</span><h2>속성</h2></div>{effectivePsdLayer ? <span className="selected-kind">{effectivePsdLayer.kind.toUpperCase()}</span> : selected && <span className="selected-kind">{selected.kind.toUpperCase()}</span>}</div>
          {!selected && !effectivePsdLayer ? <div className="empty-properties"><div className="empty-cursor"><MousePointer2 size={17} /></div><strong>오브젝트를 선택하세요</strong><span>캔버스 또는 레이어 패널에서<br />오브젝트를 선택하면 속성을 편집할 수 있어요</span></div> : effectivePsdLayer ? <div className="property-content">
            <label className="field-label">이름</label><input className="text-input" aria-label="레이어 이름" value={effectivePsdLayer.name} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { name: event.target.value })} />
            <label className="field-label position-label">위치</label><div className="field-grid"><NumberField label="X" value={effectivePsdLayer.left} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { left: Number(event.target.value) })} /><NumberField label="Y" value={effectivePsdLayer.top} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { top: Number(event.target.value) })} /></div>
            <div className="property-row position-label"><label>표시</label><button className="layer-visibility" aria-label="레이어 표시 전환" title={effectivePsdLayer.visible ? '숨기기' : '표시하기'} onClick={() => updatePsdLayer(effectivePsdLayer.id, { visible: !effectivePsdLayer.visible })}>{effectivePsdLayer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>
            <div className="property-row opacity-row"><label>불투명도</label><span className="opacity-number">{Math.round(effectivePsdLayer.opacity * 100)}%</span></div><input aria-label="레이어 불투명도" className="opacity-slider" type="range" min="0" max="100" value={Math.round(effectivePsdLayer.opacity * 100)} onChange={(event) => updatePsdLayer(effectivePsdLayer.id, { opacity: Number(event.target.value) / 100 })} />
            {psd?.warnings.length ? <div className="psd-warning" role="status">저장 전 확인: {psd.warnings.length}개 항목<br />{psd.warnings.slice(0, 3).map((warning) => warning.message).join(' ')}</div> : null}
          </div> : selected ? <div className="property-content">
            <label className="field-label">이름</label><input className="text-input" value={selected.name} onChange={(event) => updateNode(selected.id, { name: event.target.value })} />
            <label className="field-label position-label">위치</label><div className="field-grid"><NumberField label="X" value={selected.x} onChange={(event) => editDimension('x', event)} /><NumberField label="Y" value={selected.y} onChange={(event) => editDimension('y', event)} /></div>
            {selected.kind !== 'path' && <>{selected.kind !== 'aiText' && <><label className="field-label position-label">크기</label><div className="field-grid"><NumberField label="W" value={selected.width} onChange={(event) => editDimension('width', event)} /><NumberField label="H" value={selected.height} onChange={(event) => editDimension('height', event)} /></div></>}
            <div className="property-row rotation-row"><label>회전</label><div className="number-control"><input type="number" value={selected.rotation} onChange={(event) => editDimension('rotation', event)} /><span>°</span></div></div></>}
            {(selected.kind === 'text' || selected.kind === 'aiText') && <><label className="field-label position-label">텍스트</label><textarea className="text-input text-area" value={selected.text ?? ''} onChange={(event) => updateNode(selected.id, { text: event.target.value })} /><div className="property-row"><label>크기</label><div className="number-control"><input type="number" value={selected.fontSize ?? 40} onChange={(event) => updateNode(selected.id, { fontSize: Number(event.target.value) })} /><span>{selected.kind === 'aiText' ? 'pt' : 'px'}</span></div></div></>}
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
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (event: ChangeEvent<HTMLInputElement>) => void }) { return <label className="number-field"><span>{label}</span><input aria-label={label} type="number" value={Math.round(value)} onChange={onChange} /></label> }

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
