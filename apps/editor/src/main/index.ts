import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDocument } from '../shared/document'
import { openPsd, type LayerChanges, type PsdLayerView } from '@northstar/psd-bridge'
import { analyzeAi, inspectAi } from '@northstar/ai-bridge'
import { readFileWithinLimit } from './file-io'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererUrl)
const smokeCdpPort = Number(process.env.NORTHSTAR_M9_CDP_PORT)
if (process.env.NORTHSTAR_M9_BATCH_SMOKE === '1' && process.env.NORTHSTAR_GUI_SMOKE === '1' &&
  Number.isInteger(smokeCdpPort) && smokeCdpPort >= 1024 && smokeCdpPort <= 65535) {
  app.commandLine.appendSwitch('remote-debugging-port', String(smokeCdpPort))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}
const rendererHtml = path.resolve(here, '../renderer/index.html')
const preloadPath = path.resolve(here, '../preload/index.cjs')
let activeDocumentPath: string | undefined
let activeAiSourcePath: string | undefined
let activePsdSourcePath: string | undefined
const psdSessions = new Map<string, ReturnType<typeof openPsd>>()
const MAX_AI_BYTES = 64 * 1024 * 1024
const MAX_PSD_BYTES = 512 * 1024 * 1024
const MAX_NBDOC_BYTES = 64 * 1024 * 1024
const ILLUSTRATOR_AUTOMATION_TIMEOUT_MS = 120_000
const ILLUSTRATOR_PROBE_TIMEOUT_MS = 15_000
let smokeOpenFiles: string[] | undefined
let smokeOpenFileIndex = 0
let smokeIllustratorFallbackIndex = 0

function makeFlatPsd(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 30000 || height > 30000 || rgba.byteLength !== width * height * 4) throw new Error('PSD 픽셀 크기가 유효하지 않습니다.')
  const header = Buffer.alloc(26)
  header.write('8BPS', 0, 'ascii'); header.writeUInt16BE(1, 4); header.writeUInt16BE(3, 12); header.writeUInt32BE(height, 14); header.writeUInt32BE(width, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24)
  const pixelCount = width * height
  const planes = Array.from({ length: 4 }, (_, channel) => {
    const plane = Buffer.alloc(pixelCount)
    for (let pixel = 0; pixel < pixelCount; pixel++) plane[pixel] = rgba[pixel * 4 + channel]
    return plane
  })
  const layerName = Buffer.from('Flattened Artwork', 'ascii')
  const pascalName = Buffer.concat([Buffer.from([layerName.length]), layerName])
  const paddedName = Buffer.concat([pascalName, Buffer.alloc((4 - (pascalName.length % 4)) % 4)])
  const emptyExtra = Buffer.alloc(8)
  const extra = Buffer.concat([emptyExtra, paddedName])
  const layerRecord = Buffer.alloc(42)
  layerRecord.writeInt32BE(0, 0); layerRecord.writeInt32BE(0, 4); layerRecord.writeInt32BE(height, 8); layerRecord.writeInt32BE(width, 12); layerRecord.writeUInt16BE(4, 16)
  for (let channel = 0; channel < 4; channel++) { const offset = 18 + channel * 6; layerRecord.writeInt16BE(channel === 3 ? -1 : channel, offset); layerRecord.writeUInt32BE(pixelCount + 2, offset + 2) }
  const blend = Buffer.alloc(12); blend.write('8BIM', 0, 'ascii'); blend.write('norm', 4, 'ascii'); blend[8] = 255
  const extraLength = Buffer.alloc(4); extraLength.writeUInt32BE(extra.length)
  const record = Buffer.concat([layerRecord, blend, extraLength, extra])
  const layerChannels = planes.map((plane) => Buffer.concat([Buffer.alloc(2), plane]))
  const layerInfoBody = Buffer.concat([Buffer.from([0, 1]), record, ...layerChannels])
  const layerInfo = Buffer.concat([layerInfoBody, layerInfoBody.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  const layerInfoLength = Buffer.alloc(4); layerInfoLength.writeUInt32BE(layerInfo.length)
  const globalMaskLength = Buffer.alloc(4)
  const layerMaskBody = Buffer.concat([layerInfoLength, layerInfo, globalMaskLength])
  const colorModeAndResources = Buffer.alloc(8)
  const layerMaskLength = Buffer.alloc(4); layerMaskLength.writeUInt32BE(layerMaskBody.length)
  const compositeChannels: Buffer[] = []
  for (let channel = 0; channel < 3; channel++) {
    const plane = Buffer.alloc(pixelCount)
    for (let pixel = 0; pixel < pixelCount; pixel++) { const alpha = planes[3][pixel] / 255; plane[pixel] = Math.round(planes[channel][pixel] * alpha + 255 * (1 - alpha)) }
    compositeChannels.push(plane)
  }
  return Buffer.concat([header, colorModeAndResources, layerMaskLength, layerMaskBody, Buffer.alloc(2), ...compositeChannels])
}

function makePdf(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 30000 || height > 30000 || rgba.byteLength !== width * height * 4) throw new Error('PDF 픽셀 크기가 유효하지 않습니다.')
  const rgb = Buffer.alloc(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    const a = rgba[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(rgba[p * 4 + c] * a + 255 * (1 - a))
  }
  const image = deflateSync(rgb)
  const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`)
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('endstream')])
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%âãÏÓ\n')]
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.concat(chunks).length); chunks.push(Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')) }
  const xrefOffset = Buffer.concat(chunks).length
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

async function persistExport(destination: string, bytes: Buffer): Promise<number> {
  const staged = path.join(path.dirname(destination), `.${path.basename(destination)}-${randomUUID()}.tmp`)
  try {
    await writeFile(staged, bytes, { flag: 'wx' })
    const stagedInfo = await stat(staged)
    if (!stagedInfo.isFile() || stagedInfo.size !== bytes.byteLength || stagedInfo.size === 0) {
      throw new Error('내보내기 임시 파일의 실제 크기 확인에 실패했습니다.')
    }
    await publishStagedFile(staged, destination)
    const finalInfo = await stat(destination)
    if (!finalInfo.isFile() || finalInfo.size !== bytes.byteLength || finalInfo.size === 0) {
      throw new Error('저장 경로에서 내보낸 파일의 실제 크기를 확인할 수 없습니다.')
    }
    return finalInfo.size
  } finally {
    await rm(staged, { force: true })
  }
}

async function publishStagedFile(staged: string, destination: string): Promise<void> {
  try {
    // Both files are in the destination directory. A hard link publishes the complete
    // staged bytes atomically and fails with EEXIST instead of replacing an old file.
    await link(staged, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('EXPORT_DESTINATION_EXISTS:기존 파일을 보호하기 위해 내보내기를 취소했습니다. 다른 파일명을 선택해 주세요.')
    }
    throw error
  }
}

async function saveNativeIllustratorFile(svg: string, destination: string): Promise<number> {
  if (process.platform !== 'win32') throw new Error('Illustrator AI 자동 저장은 Windows에 설치된 Adobe Illustrator가 필요합니다. SVG 또는 PDF로 내보내 주세요.')
  if (!svg.trim().startsWith('<svg')) throw new Error('Illustrator에 전달할 SVG 데이터가 유효하지 않습니다.')
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'northstar-ai-export-'))
  const tempSvg = path.join(tempDir, 'artwork.svg')
  const tempJsx = path.join(tempDir, 'save-and-reopen.jsx')
  const tempAi = path.join(tempDir, 'artwork.ai')
  const stagedAi = path.join(path.dirname(destination), `.${path.basename(destination, '.ai')}-${randomUUID()}.tmp.ai`)
  const errorFile = path.join(tempDir, 'automation-error.txt')
  try {
    await writeFile(tempSvg, svg, 'utf8')
    const jsxPath = JSON.stringify(tempSvg).replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    const aiPath = JSON.stringify(tempAi).replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    const jsx = `var sourceDoc; var verifyDoc; try { sourceDoc = app.open(new File(${jsxPath})); var saveOptions = new IllustratorSaveOptions(); saveOptions.pdfCompatible = true; sourceDoc.saveAs(new File(${aiPath}), saveOptions); sourceDoc.close(SaveOptions.DONOTSAVECHANGES); sourceDoc = null; verifyDoc = app.open(new File(${aiPath})); if (!verifyDoc) throw new Error("Saved AI could not be reopened"); verifyDoc.close(SaveOptions.DONOTSAVECHANGES); verifyDoc = null; "OK"; } catch (e) { try { if (verifyDoc) verifyDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {} try { if (sourceDoc) sourceDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {} throw e; }`
    await writeFile(tempJsx, jsx, 'ascii')
    const ps = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false; $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false; try { $app = New-Object -ComObject Illustrator.Application } catch { [IO.File]::WriteAllText($env:NORTHSTAR_ILLUSTRATOR_ERROR, ('NO_ILLUSTRATOR: ' + $_.Exception.Message), $utf8); exit 24 }; try { $result = $app.DoJavaScriptFile($env:NORTHSTAR_ILLUSTRATOR_SCRIPT); if ($result -ne 'OK') { throw "Illustrator scripting failed: $result" } } catch { [IO.File]::WriteAllText($env:NORTHSTAR_ILLUSTRATOR_ERROR, $_.Exception.ToString(), $utf8); exit 23 }`
    const encoded = Buffer.from(ps, 'utf16le').toString('base64')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, NORTHSTAR_ILLUSTRATOR_SCRIPT: tempJsx, NORTHSTAR_ILLUSTRATOR_ERROR: errorFile }
      })
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish(new Error(`ILLUSTRATOR_TIMEOUT: ${ILLUSTRATOR_AUTOMATION_TIMEOUT_MS / 1000}초 안에 Illustrator 자동화가 끝나지 않았습니다.`))
      }, ILLUSTRATOR_AUTOMATION_TIMEOUT_MS)
      // PowerShell redirection may use an OEM code page. Read diagnostics from the UTF-8 file instead.
      child.stderr?.on('data', () => undefined)
      child.once('error', (error) => finish(new Error(`AUTOMATION_HOST_UNAVAILABLE: ${error.message}`)))
      child.once('close', async (code) => {
        if (code === 0) return finish()
        let detail = `PowerShell exited with code ${code}`
        try { detail = (await readFile(errorFile, 'utf8')).trim() || detail } catch { /* no diagnostic file */ }
        if (/user\s*cancel|cancelled|canceled|operation canceled|취소|800704c7|2147023673/i.test(detail)) return finish(new Error(`ILLUSTRATOR_CANCELLED: ${detail}`))
        finish(new Error(detail))
      })
    })
    const saved = await readFile(tempAi)
    if (saved.byteLength < 32 || saved.subarray(0, 5).toString('ascii') !== '%PDF-' || saved.lastIndexOf(Buffer.from('%%EOF')) < 0) {
      throw new Error('Illustrator 재열기는 성공했지만 저장 파일의 PDF 호환 AI 서명 또는 끝 표시가 유효하지 않습니다.')
    }
    await writeFile(stagedAi, saved, { flag: 'wx' })
    const stagedInfo = await stat(stagedAi)
    if (!stagedInfo.isFile() || stagedInfo.size !== saved.byteLength || stagedInfo.size === 0) throw new Error('저장한 AI 파일의 실제 크기 확인에 실패했습니다.')
    await publishStagedFile(stagedAi, destination)
    const finalInfo = await stat(destination)
    if (!finalInfo.isFile() || finalInfo.size !== saved.byteLength || finalInfo.size === 0) throw new Error('저장 경로에서 AI 파일의 실제 크기를 확인할 수 없습니다.')
    const finalBytes = await readFile(destination)
    const savedHash = createHash('sha256').update(saved).digest('hex')
    if (createHash('sha256').update(finalBytes).digest('hex') !== savedHash) throw new Error('저장된 AI 파일의 SHA-256 무결성 확인에 실패했습니다.')
    return finalInfo.size
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.startsWith('EXPORT_DESTINATION_EXISTS:')) throw new Error(detail.slice('EXPORT_DESTINATION_EXISTS:'.length))
    if (detail.includes('NO_ILLUSTRATOR:')) {
      throw new Error('Illustrator 자동화를 사용할 수 없어 .ai 파일을 저장하지 못했습니다. SVG 또는 PDF로 내보내 주세요.')
    }
    if (detail.includes('AUTOMATION_HOST_UNAVAILABLE:')) {
      throw new Error('Illustrator 자동화를 시작하지 못해 .ai 파일을 저장하지 못했습니다. 설치 상태를 확인하거나 SVG 또는 PDF로 내보내 주세요.')
    }
    if (detail.includes('ILLUSTRATOR_TIMEOUT:')) {
      throw new Error('Illustrator 자동화 시간이 초과되어 .ai 파일을 저장하지 못했습니다. Illustrator가 응답하는지 확인한 뒤 다시 시도하거나 SVG 또는 PDF로 내보내 주세요.')
    }
    if (detail.includes('ILLUSTRATOR_CANCELLED:')) {
      throw new Error('Illustrator 내보내기가 취소되어 .ai 파일을 저장하지 않았습니다. SVG 또는 PDF로 내보낼 수 있습니다.')
    }
    throw new Error('Illustrator가 파일을 .ai로 저장하거나 다시 열지 못했습니다. 기존 파일은 보호했으며 .ai 파일을 저장하지 않았습니다. SVG 또는 PDF로 내보내 주세요.')
  } finally {
    await Promise.all([rm(tempDir, { recursive: true, force: true }), rm(stagedAi, { force: true })])
  }
}

async function canAutomateIllustrator(): Promise<boolean> {
  if (process.env.NORTHSTAR_GUI_SMOKE === '1' && process.env.NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_UNAVAILABLE === '1') return false
  if (process.platform !== 'win32') return false
  const script = "$ErrorActionPreference = 'Stop'; try { $app = New-Object -ComObject Illustrator.Application; if (-not $app) { exit 1 }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app); exit 0 } catch { exit 1 }"
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    let settled = false
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(available)
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' })
    const timeout = setTimeout(() => { child.kill(); finish(false) }, ILLUSTRATOR_PROBE_TIMEOUT_MS)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

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

async function canonicalDestination(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath)
  try { return await realpath(absolutePath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.join(await realpath(path.dirname(absolutePath)), path.basename(absolutePath))
  }
}

async function isSameFileOrPath(sourcePath: string, destinationPath: string): Promise<boolean> {
  const destination = await canonicalDestination(destinationPath)
  const source = await realpath(sourcePath)
  const samePath = process.platform === 'win32'
    ? destination.toLocaleLowerCase('en-US') === source.toLocaleLowerCase('en-US')
    : destination === source
  if (samePath) return true
  try {
    const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)])
    return sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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
  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) console.info(`[renderer] main-frame navigation started (inPlace=${isInPlace}): ${url}`)
  })
  window.webContents.on('did-finish-load', () => {
    console.info(`[renderer] main-frame load finished: ${window.webContents.getURL()}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    console.error(`[renderer] load failed (code=${code}, mainFrame=${isMainFrame}) ${description}: ${url}`)
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
  if (activeAiSourcePath && await isSameFileOrPath(activeAiSourcePath, savePath)) {
    throw new Error('원본 AI 파일은 덮어쓸 수 없습니다. .nbdoc 경로를 선택해 주세요.')
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
  let filePath: string | undefined
  if (process.env.NORTHSTAR_GUI_SMOKE === '1') {
    const openFilesJson = process.env.NORTHSTAR_GUI_SMOKE_OPEN_FILES
    if (openFilesJson) {
      try {
        smokeOpenFiles ??= JSON.parse(openFilesJson)
      } catch {
        throw new Error('GUI smoke open-file list is not valid JSON.')
      }
      if (!Array.isArray(smokeOpenFiles) || smokeOpenFiles.some((item) => typeof item !== 'string')) {
        throw new Error('GUI smoke open-file list must be an array of paths.')
      }
      filePath = smokeOpenFiles[smokeOpenFileIndex++]
    }
    filePath ??= process.env.NORTHSTAR_GUI_SMOKE_OPEN_FILE ?? activeDocumentPath ?? process.env.NORTHSTAR_GUI_SMOKE_AI_FILE ?? process.env.NORTHSTAR_GUI_SMOKE_FILE
  }
  if (!filePath) {
    const options: OpenDialogOptions = { title: '문서 열기', properties: ['openFile'], filters: [{ name: '지원 문서', extensions: ['nbdoc', 'psd', 'ai'] }, { name: 'Illustrator 문서', extensions: ['ai'] }, { name: 'Photoshop 문서', extensions: ['psd'] }, { name: 'Northstar 문서', extensions: ['nbdoc'] }] }
    const result = await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    filePath = result.filePaths[0]
  }
  if (path.extname(filePath).toLowerCase() === '.ai') {
    const sourcePath = await realpath(filePath)
    const bytes = await readFileWithinLimit(sourcePath, MAX_AI_BYTES, 'AI')
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
    activePsdSourcePath = undefined
    return { filePath, document, aiImport: { pdfVersion: source.pdfVersion, sourceName: path.basename(filePath), limitations: 'Illustrator 전용 데이터는 읽거나 보존하지 않습니다. 변환 문서는 .nbdoc로만 저장됩니다.' } }
  }
  if (path.extname(filePath).toLowerCase() === '.psd') {
    const sourcePath = await realpath(filePath)
    const psd = openPsd(await readFileWithinLimit(sourcePath, MAX_PSD_BYTES, 'PSD'))
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    psdSessions.clear()
    psdSessions.set(sessionId, psd)
    activeDocumentPath = undefined
    activeAiSourcePath = undefined
    activePsdSourcePath = sourcePath
    return { filePath: sourcePath, psd: { sessionId, name: path.basename(filePath, '.psd'), width: psd.width, height: psd.height, bitDepth: psd.bitDepth, layers: flattenPsdTree(psd.readTree()), warnings: psd.warnings } }
  }
  const document = validateDocument(JSON.parse((await readFileWithinLimit(filePath, MAX_NBDOC_BYTES, '.nbdoc')).toString('utf8')))
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
  activePsdSourcePath = undefined
  return { filePath, document }
})

ipcMain.handle('psd:save', async (_event, payload: { sessionId: string; edits: Array<{ id: string; changes: LayerChanges }> }) => {
  const session = psdSessions.get(payload.sessionId)
  if (!session) throw new Error('PSD 편집 세션이 만료되었습니다. 파일을 다시 열어 주세요.')
  const tree = session.readTree()
  const unsupported = session.warnings.filter((warning) => warning.code === 'special-layer')
  if (unsupported.length) {
    const details = unsupported.slice(0, 3).map((warning) => warning.message).join(' ')
    throw new Error(`지원되지 않는 PSD 레이어 구조가 있어 저장을 거부했습니다. 텍스트·조정·스마트 오브젝트·벡터 레이어를 래스터화한 사본을 사용해 주세요. ${details}`)
  }
  let filePath = activeDocumentPath
  if (process.env.NORTHSTAR_GUI_SMOKE === '1') filePath = process.env.NORTHSTAR_GUI_SMOKE_PSD_FILE ?? filePath
  if (!filePath) {
    const source = activePsdSourcePath
    const defaultPath = source ? path.join(path.dirname(source), `${path.basename(source, path.extname(source))}-edited.psd`) : 'Untitled.psd'
    const result = await dialog.showSaveDialog({ title: 'PSD 사본 저장', defaultPath, filters: [{ name: 'Photoshop 문서', extensions: ['psd'] }] })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath.toLowerCase().endsWith('.psd') ? result.filePath : `${result.filePath}.psd`
  }
  if (!filePath) return null
  if (path.extname(filePath).toLowerCase() !== '.psd') throw new Error('편집된 PSD 사본은 .psd 파일로 저장해 주세요.')
  if (activePsdSourcePath && await isSameFileOrPath(activePsdSourcePath, filePath)) {
    throw new Error('열어 둔 PSD 원본은 덮어쓸 수 없습니다. 다른 .psd 경로에 사본으로 저장해 주세요.')
  }
  const beforeIds = new Set<string>()
  const collect = (layers: PsdLayerView[]) => layers.forEach((layer) => { beforeIds.add(layer.id); if (layer.children) collect(layer.children) })
  collect(tree)
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

ipcMain.handle('document:export', async (_event, payload: { format: 'png' | 'jpeg' | 'svg' | 'pdf' | 'psd' | 'ai'; width: number; height: number; svg?: string; pixels?: Uint8Array; image?: Uint8Array; name: string }) => {
  const formats = {
    png: { extension: 'png', label: 'PNG 이미지' }, jpeg: { extension: 'jpg', label: 'JPEG 이미지' },
    svg: { extension: 'svg', label: 'SVG 벡터' }, pdf: { extension: 'pdf', label: 'PDF 문서' }, psd: { extension: 'psd', label: '평면 Photoshop 문서' }, ai: { extension: 'ai', label: 'Illustrator AI' }
  } as const
  let format = payload?.format
  let spec = formats[format]
  if (!spec) throw new Error('지원하지 않는 내보내기 형식입니다.')
  if (format === 'ai') {
    const available = await canAutomateIllustrator()
    if (!available) {
      let chooseSvg: boolean
      if (process.env.NORTHSTAR_GUI_SMOKE === '1' && process.env.NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_UNAVAILABLE === '1') {
        const choices = (process.env.NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_FALLBACK ?? 'cancel').split(',')
        const choice = choices[Math.min(smokeIllustratorFallbackIndex++, choices.length - 1)]
        chooseSvg = choice === 'svg'
      } else {
        const choice = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['SVG로 내보내기', '취소'],
          defaultId: 0,
          cancelId: 1,
          message: 'Illustrator 자동화를 사용할 수 없습니다.',
          detail: 'Illustrator.Application COM 등록이 없거나 자동화 시작에 실패했습니다. .ai 파일은 저장되지 않습니다. SVG로 내보내시겠습니까?'
        })
        chooseSvg = choice.response === 0
      }
      if (!chooseSvg) return null
      format = 'svg'
      spec = formats.svg
    }
  }
  const sourcePath = activePsdSourcePath ?? activeAiSourcePath ?? activeDocumentPath
  const safeName = (typeof payload.name === 'string' ? payload.name : 'Untitled').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Untitled'
  const smokeFormat = format === 'svg' && payload.format === 'ai' ? 'AI_SVG' : format.toUpperCase()
  const smokePath = process.env.NORTHSTAR_GUI_SMOKE === '1' ? process.env[`NORTHSTAR_GUI_SMOKE_EXPORT_${smokeFormat}`] ?? process.env[`NORTHSTAR_GUI_SMOKE_EXPORT_${format.toUpperCase()}`] : undefined
  const result = smokePath ? { canceled: false, filePath: smokePath } : await dialog.showSaveDialog({
    title: `${spec.label} 내보내기`, defaultPath: `${safeName}.${spec.extension}`,
    filters: [{ name: spec.label, extensions: [spec.extension] }]
  })
  if (result.canceled || !result.filePath) return null
  let destination = path.resolve(result.filePath)
  if (path.extname(destination).toLowerCase() !== `.${spec.extension}`) destination += `.${spec.extension}`
  if (sourcePath && await isSameFileOrPath(sourcePath, destination)) throw new Error('열어 둔 원본 파일은 덮어쓸 수 없습니다. 다른 경로로 내보내 주세요.')
  if (format === 'ai') {
    if (typeof payload.svg !== 'string') throw new Error('Illustrator AI 저장용 SVG가 없습니다.')
    const bytes = await saveNativeIllustratorFile(payload.svg, destination)
    return { filePath: destination, bytes }
  }
  const width = payload.width; const height = payload.height
  let output: Buffer
  if (format === 'svg') {
    if (typeof payload.svg !== 'string' || !payload.svg.trim().startsWith('<svg')) throw new Error('SVG 내보내기 데이터가 유효하지 않습니다.')
    output = Buffer.from(payload.svg, 'utf8')
  } else if (format === 'png' || format === 'jpeg') {
    if (!(payload.image instanceof Uint8Array) || payload.image.byteLength < 8) throw new Error('이미지 데이터가 없습니다.')
    output = Buffer.from(payload.image)
  } else {
    if (!(payload.pixels instanceof Uint8Array)) throw new Error('픽셀 데이터가 없습니다.')
    output = format === 'psd' ? makeFlatPsd(width, height, payload.pixels) : makePdf(width, height, payload.pixels)
  }
  const bytes = await persistExport(destination, output)
  if (format === 'svg') {
    const savedSvg = await readFile(destination)
    const savedText = savedSvg.toString('utf8').trim()
    if (savedSvg.byteLength !== output.byteLength || !savedSvg.equals(output) || !savedText.startsWith('<svg') || !savedText.endsWith('</svg>')) {
      throw new Error('저장된 SVG 파일의 실제 내용 검증에 실패했습니다.')
    }
  }
  return { filePath: destination, bytes }
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
