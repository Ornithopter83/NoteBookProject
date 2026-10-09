import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDocument } from '../shared/document'
import { openPsd, type LayerChanges, type PsdLayerView } from '@northstar/psd-bridge'
import { analyzeAi, inspectAi } from '@northstar/ai-bridge'
import { readFileWithinLimit } from './file-io'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererUrl)
const rendererHtml = path.resolve(here, '../renderer/index.html')
const preloadPath = path.resolve(here, '../preload/index.cjs')
let activeDocumentPath: string | undefined
let activeAiSourcePath: string | undefined
const psdSessions = new Map<string, ReturnType<typeof openPsd>>()

function flattenPsdTree(tree: PsdLayerView[]): PsdLayerView[] {
  return tree.map((layer) => ({
    ...layer,
    children: layer.children ? flattenPsdTree(layer.children) : undefined
  }))
}

function allowsRendererNavigation(target: string): boolean {
  try {
    const targetUrl = new URL(target)
    if (isDev) return targetUrl.origin === new URL(rendererUrl!).origin
    return targetUrl.href === pathToFileURL(rendererHtml).href
  } catch {
    return false
  }
}

function isDescendantPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath)
  return relativePath !== '' && relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 680,
    backgroundColor: '#111214', title: 'Northstar — 편집기',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!allowsRendererNavigation(target)) event.preventDefault()
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] load failed (${code}) ${description}: ${url}`)
  })
  const load = isDev ? window.loadURL(rendererUrl!) : window.loadFile(rendererHtml)
  void load.catch((error: unknown) => console.error('[renderer] window load failed:', error))
}

ipcMain.handle('document:save', async (_event, payload: { document: unknown }) => {
  const smokePath = process.env.NORTHSTAR_GUI_SMOKE === '1' ? process.env.NORTHSTAR_GUI_SMOKE_FILE : undefined
  const result = activeDocumentPath || smokePath
    ? { filePath: activeDocumentPath ?? smokePath!, canceled: false }
    : await dialog.showSaveDialog({ title: '문서 저장', defaultPath: 'Untitled.nbdoc', filters: [{ name: 'Northstar 문서', extensions: ['nbdoc'] }] })
  if (result.canceled || !result.filePath) return null
  const savePath = path.resolve(result.filePath)
  if (path.extname(savePath).toLowerCase() !== '.nbdoc') throw new Error('변환 문서는 .nbdoc 파일로만 저장할 수 있습니다.')
  if (activeAiSourcePath) {
    let destinationPath: string
    try {
      destinationPath = await realpath(savePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      destinationPath = path.join(await realpath(path.dirname(savePath)), path.basename(savePath))
    }
    if (destinationPath.toLowerCase() === activeAiSourcePath.toLowerCase()) {
      throw new Error('원본 AI 파일은 덮어쓸 수 없습니다. .nbdoc 경로를 선택해 주세요.')
    }
  }
  const document = validateDocument(structuredClone(payload.document))
  const assetDir = path.join(path.dirname(savePath), `${path.basename(savePath, '.nbdoc')}.assets`)
  for (const node of document.nodes) {
    if (node.kind !== 'image' || !node.src?.startsWith('data:image/')) continue
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([\s\S]+)$/.exec(node.src)
    if (!match) throw new Error('지원하지 않는 이미지 데이터입니다.')
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
    const fileName = `${node.id.replace(/[^a-z0-9_-]/gi, '')}.${extension}`
    await mkdir(assetDir, { recursive: true })
    await writeFile(path.join(assetDir, fileName), Buffer.from(match[2], 'base64'))
    node.resourcePath = `${path.basename(assetDir)}/${fileName}`
    delete node.src
  }
  document.name = path.basename(savePath, '.nbdoc')
  await writeFile(savePath, JSON.stringify(document, null, 2), 'utf8')
  activeDocumentPath = savePath
  return { filePath: savePath, document }
})

ipcMain.handle('document:open', async () => {
  let filePath = process.env.NORTHSTAR_GUI_SMOKE === '1' ? (activeDocumentPath ?? process.env.NORTHSTAR_GUI_SMOKE_AI_FILE ?? process.env.NORTHSTAR_GUI_SMOKE_FILE) : undefined
  if (!filePath) {
    const options: OpenDialogOptions = { title: '문서 열기', properties: ['openFile'], filters: [{ name: '지원 문서', extensions: ['nbdoc', 'psd', 'ai'] }, { name: 'Illustrator 문서', extensions: ['ai'] }, { name: 'Photoshop 문서', extensions: ['psd'] }, { name: 'Northstar 문서', extensions: ['nbdoc'] }] }
    const result = await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    filePath = result.filePaths[0]
  }
  if (path.extname(filePath).toLowerCase() === '.ai') {
    const sourcePath = await realpath(filePath)
    const bytes = await readFileWithinLimit(sourcePath, 64 * 1024 * 1024, 'AI')
    const report = inspectAi(bytes)
    if (!report.compatible || report.status !== 'pdf-compatible-ai') throw new Error(report.reason ?? 'PDF 호환 Illustrator AI 파일이 아닙니다.')
    if (report.pages !== 1) throw new Error('한 페이지 PDF 호환 AI 파일만 가져올 수 있습니다.')
      const source = analyzeAi(bytes)
      const page = source.pages[0]
      const nodes = page.items.map((item, index) => {
        if (item.type === 'path') {
          let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
          for (const segment of item.segments) for (const [pointX, pointY] of segment.points) {
            minX = Math.min(minX, pointX); minY = Math.min(minY, pointY)
            maxX = Math.max(maxX, pointX); maxY = Math.max(maxY, pointY)
          }
          const x = Number.isFinite(minX) ? minX : 0; const y = Number.isFinite(minY) ? minY : 0
          return { id: `ai-path-${index + 1}`, name: `AI 경로 ${index + 1}`, kind: 'path' as const, x, y, width: Math.max(1, Number.isFinite(maxX) ? maxX - x : 0), height: Math.max(1, Number.isFinite(maxY) ? maxY - y : 0), fill: '#000000', opacity: 100, rotation: 0, visible: true, locked: false, pathSegments: item.segments, pathPaint: item.paint }
        }
      const [x, y] = item.position
      return { id: `ai-text-${index + 1}`, name: `AI 텍스트 ${index + 1}`, kind: 'aiText' as const, x, y, width: Math.max(1, item.text.length * item.fontSize * 0.6), height: Math.max(1, item.fontSize), fill: '#000000', opacity: 100, rotation: 0, visible: true, locked: false, text: item.text, fontSize: item.fontSize }
    })
    const document = validateDocument({ format: 'northstar-document', version: 1, name: path.basename(filePath, '.ai'), width: page.width, height: page.height, background: '#ffffff', nodes })
    activeDocumentPath = undefined
    activeAiSourcePath = sourcePath
    return { filePath, document, aiImport: { pdfVersion: source.pdfVersion, sourceName: path.basename(filePath), limitations: 'Illustrator 전용 데이터는 읽거나 보존하지 않습니다. 변환 문서는 .nbdoc로만 저장됩니다.' } }
  }
  if (path.extname(filePath).toLowerCase() === '.psd') {
    const psd = openPsd(await readFileWithinLimit(filePath, 512 * 1024 * 1024, 'PSD'))
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    psdSessions.clear()
    psdSessions.set(sessionId, psd)
    activeDocumentPath = filePath
    activeAiSourcePath = undefined
    return { filePath, psd: { sessionId, name: path.basename(filePath, '.psd'), width: psd.width, height: psd.height, bitDepth: psd.bitDepth, layers: flattenPsdTree(psd.readTree()), warnings: psd.warnings } }
  }
  const document = validateDocument(JSON.parse(await readFile(filePath, 'utf8')))
  const assetRoot = path.resolve(path.dirname(filePath), `${path.basename(filePath, '.nbdoc')}.assets`)
  for (const node of document.nodes) {
    if (node.kind !== 'image' || !node.resourcePath) continue
    const segments = node.resourcePath.split(/[\\/]/)
    if (segments.length !== 2 || segments[0] !== path.basename(assetRoot) || segments.some((part) => part === '..' || part === '.' || !part)) throw new Error('잘못된 리소스 경로입니다.')
    const absolute = path.resolve(path.dirname(filePath), node.resourcePath)
    const documentRoot = await realpath(path.dirname(filePath))
    const actualAssetRoot = await realpath(assetRoot)
    const actualFile = await realpath(absolute)
    if (!isDescendantPath(documentRoot, actualAssetRoot)) throw new Error('문서 외부 리소스는 열 수 없습니다.')
    if (!isDescendantPath(actualAssetRoot, actualFile)) throw new Error('문서 외부 리소스는 열 수 없습니다.')
    const bytes = await readFile(actualFile)
    const mime = path.extname(absolute).toLowerCase() === '.jpg' || path.extname(absolute).toLowerCase() === '.jpeg' ? 'image/jpeg' : `image/${path.extname(absolute).slice(1)}`
    node.src = `data:${mime};base64,${bytes.toString('base64')}`
  }
  activeDocumentPath = filePath
  activeAiSourcePath = undefined
  return { filePath, document }
})

ipcMain.handle('psd:save', async (_event, payload: { sessionId: string; edits: Array<{ id: string; changes: LayerChanges }> }) => {
  const session = psdSessions.get(payload.sessionId)
  if (!session) throw new Error('PSD 편집 세션이 만료되었습니다. 파일을 다시 열어 주세요.')
  let filePath = activeDocumentPath
  if (process.env.NORTHSTAR_GUI_SMOKE === '1') filePath = process.env.NORTHSTAR_GUI_SMOKE_PSD_FILE ?? filePath
  if (!filePath) {
    const result = await dialog.showSaveDialog({ title: 'PSD 저장', defaultPath: 'Untitled.psd', filters: [{ name: 'Photoshop 문서', extensions: ['psd'] }] })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath.toLowerCase().endsWith('.psd') ? result.filePath : `${result.filePath}.psd`
  }
  const beforeIds = new Set<string>()
  const collect = (layers: PsdLayerView[]) => layers.forEach((layer) => { beforeIds.add(layer.id); if (layer.children) collect(layer.children) })
  collect(session.readTree())
  for (const edit of payload.edits) {
    if (!beforeIds.has(edit.id)) throw new Error('레이어 구조가 변경되어 저장할 수 없습니다. PSD를 다시 열어 주세요.')
    session.editLayer(edit.id, edit.changes)
  }
  await writeFile(filePath, session.save())
  activeDocumentPath = filePath
  return { filePath }
})

ipcMain.handle('image:import', async () => {
  const result = await dialog.showOpenDialog({ title: '이미지 가져오기', properties: ['openFile'], filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = result.filePaths[0]
  const extension = path.extname(filePath).toLowerCase().slice(1)
  const mime = extension === 'jpg' ? 'jpeg' : extension
  const bytes = await readFile(filePath)
  return `data:image/${mime};base64,${bytes.toString('base64')}`
})

void app.whenReady().then(() => {
  console.info(`[startup] renderer mode=${isDev ? 'development' : 'production'} html=${rendererHtml} preload=${preloadPath}`)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((error: unknown) => {
  console.error('[startup] application initialization failed:', error)
  app.exit(1)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
