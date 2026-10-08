import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDocument } from '../shared/document'

const here = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
let activeDocumentPath: string | undefined

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 680,
    backgroundColor: '#111214', title: 'Northstar — 편집기',
    webPreferences: {
      preload: path.join(here, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    const rendererUrl = pathToFileURL(path.join(here, '../renderer/index.html')).href
    const allowed = isDev ? target.startsWith('http://localhost:5173/') : target === rendererUrl
    if (!allowed) event.preventDefault()
  })
  if (isDev) void window.loadURL('http://localhost:5173')
  else void window.loadFile(path.join(here, '../renderer/index.html'))
}

ipcMain.handle('document:save', async (_event, payload: { document: unknown }) => {
  const result = activeDocumentPath
    ? { filePath: activeDocumentPath, canceled: false }
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
  const options: OpenDialogOptions = { title: '문서 열기', properties: ['openFile'], filters: [{ name: 'Northstar 문서', extensions: ['nbdoc'] }] }
  const result = await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = result.filePaths[0]
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
    if (!actualAssetRoot.startsWith(documentRoot + path.sep)) throw new Error('문서 외부 리소스는 열 수 없습니다.')
    if (!actualFile.startsWith(actualAssetRoot + path.sep)) throw new Error('문서 외부 리소스는 열 수 없습니다.')
    const bytes = await readFile(actualFile)
    const mime = path.extname(absolute).toLowerCase() === '.jpg' || path.extname(absolute).toLowerCase() === '.jpeg' ? 'image/jpeg' : `image/${path.extname(absolute).slice(1)}`
    node.src = `data:${mime};base64,${bytes.toString('base64')}`
  }
  activeDocumentPath = filePath
  return { filePath, document }
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
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
