import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDocument } from '../shared/document'
import { openPsd, type LayerChanges, type PsdLayerView } from '../../../../packages/psd-bridge/src/index'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererUrl)
const rendererHtml = path.resolve(here, '../renderer/index.html')
const preloadPath = path.resolve(here, '../preload/index.js')
let activeDocumentPath: string | undefined
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
  const document = validateDocument(structuredClone(payload.document))
  const assetDir = path.join(path.dirname(result.filePath), `${path.basename(result.filePath, '.nbdoc')}.assets`)
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
  document.name = path.basename(result.filePath, '.nbdoc')
  await writeFile(result.filePath, JSON.stringify(document, null, 2), 'utf8')
  activeDocumentPath = result.filePath
  return { filePath: result.filePath, document }
})

ipcMain.handle('document:open', async () => {
  let filePath = process.env.NORTHSTAR_GUI_SMOKE === '1' ? process.env.NORTHSTAR_GUI_SMOKE_FILE : undefined
  if (!filePath) {
    const options: OpenDialogOptions = { title: '문서 열기', properties: ['openFile'], filters: [{ name: '지원 문서', extensions: ['nbdoc', 'psd'] }, { name: 'Photoshop 문서', extensions: ['psd'] }, { name: 'Northstar 문서', extensions: ['nbdoc'] }] }
    const result = await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    filePath = result.filePaths[0]
  }
  if (path.extname(filePath).toLowerCase() === '.psd') {
    const psd = openPsd(await readFile(filePath))
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    psdSessions.clear()
    psdSessions.set(sessionId, psd)
    activeDocumentPath = filePath
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
