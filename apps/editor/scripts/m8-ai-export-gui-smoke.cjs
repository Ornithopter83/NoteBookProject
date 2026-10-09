const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { inflateSync } = require('node:zlib')

const ILLUSTRATOR_AUTOMATION_TIMEOUT_MS = 120_000
const ILLUSTRATOR_RENDERER_GRACE_MS = 10_000

const appRoot = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m8-ai-export-'))
const input = path.join(root, '사진 원본.nbdoc')
const output = { ai: path.join(root, '사진 결과.ai'), aiSvg: path.join(root, 'AI 대안.svg'), svg: path.join(root, '사진 대안.svg'), pdf: path.join(root, '사진 대안.pdf') }
const image = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Cf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Cf//aAAwDAQACAAMAAAAQ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k='
const source = { format: 'northstar-document', version: 1, name: '사진 원본', width: 1440, height: 960, background: '#e8dfcd', groups: [], nodes: [
  { id: 'photo', name: 'JPEG 사진', kind: 'image', x: 110, y: 90, width: 1220, height: 780, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/jpeg;base64,${image}`, visible: true, locked: false }
] }
fs.writeFileSync(input, JSON.stringify(source), 'utf8')
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex')
const logPath = path.join(root, 'electron.log')
const resultPath = process.env.NORTHSTAR_M8_RESULT_FILE
const originalSvgPath = process.env.NORTHSTAR_M8_SOURCE_SVG
const originalRenderPath = process.env.NORTHSTAR_M8_SOURCE_RENDER
const results = { fixture: 'pending', illustrator: 'pending', originalSvg: 'not-provided', cleanup: 'pending' }
function log(message) { console.log(`[m8-ai-export-gui-smoke] ${message}`) }
function writeResults() {
  if (!resultPath) return
  fs.mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true })
  fs.writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
async function targetAt(child, port) {
  const until = Date.now() + 30000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for Electron renderer')
}

function hasIllustratorComRegistration() {
  if (process.platform !== 'win32') return false
  const script = "$ErrorActionPreference = 'Stop'; try { $app = New-Object -ComObject Illustrator.Application; if (-not $app) { exit 1 }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app); exit 0 } catch { exit 1 }"
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore', timeout: 20000 })
    return true
  } catch {
    return false
  }
}

async function main() {
  assert.match(execFileSync(require('electron'), ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const illustratorAvailable = hasIllustratorComRegistration()
  const port = await freePort()
  const electronEnv = { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: input, NORTHSTAR_GUI_SMOKE_OPEN_FILE: input,
    NORTHSTAR_GUI_SMOKE_EXPORT_AI: output.ai, NORTHSTAR_GUI_SMOKE_EXPORT_AI_SVG: output.aiSvg, NORTHSTAR_GUI_SMOKE_EXPORT_SVG: output.svg, NORTHSTAR_GUI_SMOKE_EXPORT_PDF: output.pdf }
  delete electronEnv.NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_UNAVAILABLE
  delete electronEnv.NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_FALLBACK
  const child = spawn(require('electron'), [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: electronEnv
  })
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' }); child.stdout.pipe(logStream); child.stderr.pipe(logStream)
  let socket; let id = 0
  const pending = new Map(); const errors = []
  try {
    const target = await targetAt(child, port)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) { const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) } }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Renderer exception')
      if (message.method === 'Page.javascriptDialogOpening') socket.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
    })
    await once(socket, 'open')
    const cdp = (method, params = {}) => { const requestId = ++id; return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) }) }
    const evaluate = async (expression) => { const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
    const waitFor = async (expression, description) => { const until = Date.now() + 30000; while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 150)) } throw new Error(`Timed out waiting for ${description}`) }
    const waitForFileAndStatus = async (filePath, successText, description, timeout = 30000) => {
      const until = Date.now() + timeout
      while (Date.now() < until) {
        const status = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
        if (fs.existsSync(filePath) && status.includes(successText) && status.includes(path.basename(filePath))) return status
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`Timed out waiting for ${description}: file and matching filename status`)
    }
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'editor canvas')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open source fixture')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')?.getAttribute('viewBox') === '0 0 1440 960' && document.querySelector('.document-tab')?.innerText.includes('사진 원본') && document.querySelector('.layer-name')?.innerText.includes('JPEG 사진') && document.querySelector('[data-node-id=photo] image')?.getAttribute('href')?.startsWith('data:image/jpeg;base64,')", 'photo document and JPEG node loaded')
    const loadedJpeg = await evaluate("(async () => { const source = document.querySelector('[data-node-id=photo] image')?.getAttribute('href'); if (!source) return null; const image = new Image(); image.src = source; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight } })()")
    assert.deepEqual(loadedJpeg, { width: 1, height: 1 }, 'JPEG node did not decode as the expected loaded photo fixture')
    const chooseExport = async (label) => {
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
      await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `${label} export`)
    }
    if (illustratorAvailable) {
      const automationTempDirsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('northstar-ai-export-')))
      await chooseExport('Illustrator AI')
      const { inspectAi } = await import('@northstar/ai-bridge')
      const status = await waitForFileAndStatus(output.ai, 'Illustrator AI를 저장했습니다', 'native AI save and reopen', ILLUSTRATOR_AUTOMATION_TIMEOUT_MS + ILLUSTRATOR_RENDERER_GRACE_MS)
      const bytes = fs.readFileSync(output.ai); const report = inspectAi(bytes)
      assert.equal(report.status, 'pdf-compatible-ai', 'Output is not PDF-compatible native Illustrator AI')
      assert.equal(report.compatible, true)
      assert.ok(bytes.length > 100, 'AI output is empty')
      assert.match(status, /Illustrator AI를 저장했습니다/)
      results.illustrator = 'passed: native AI saveAs, close, reopen, and close verified by Illustrator automation'
      log('RESULT illustrator=PASS native .ai saved with PDF compatibility and reopened by Illustrator automation')
      const newAutomationTempDirs = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('northstar-ai-export-') && !automationTempDirsBefore.has(name))
      assert.deepEqual(newAutomationTempDirs, [], 'Illustrator automation temporary directory was left behind')
    } else {
      results.illustrator = 'unverified: Illustrator COM is not registered; actual native warning-dialog Cancel/SVG selection is covered by the independent m11-native-dialog-gui-smoke.ps1 check'
      log('RESULT illustrator=UNVERIFIED COM is not registered; no test-only choice override was used; see independent M11 native-dialog GUI check')
    }
    await chooseExport('Illustrator용 SVG')
    await waitForFileAndStatus(output.svg, 'SVG를 내보냈습니다', 'explicit SVG export')
    const svg = fs.readFileSync(output.svg, 'utf8')
    assert.match(svg, /width="1440"/); assert.match(svg, /height="960"/); assert.match(svg, /#e8dfcd/)
    assert.match(svg, /data:image\/jpeg;base64,/); assert.match(svg, /preserveAspectRatio="xMidYMid slice"/)
    await chooseExport('PDF 문서')
    await waitForFileAndStatus(output.pdf, 'PDF를 내보냈습니다', 'PDF export')
    const pdf = fs.readFileSync(output.pdf)
    const pdfText = pdf.toString('latin1')
    assert.match(pdfText, /^%PDF-1\.4/)
    assert.match(pdfText, /\/MediaBox \[0 0 1440 960\]/, 'PDF page bounds do not match the 1440x960 canvas')
    assert.match(pdfText, /startxref\n\d+\n%%EOF\n?$/, 'PDF cross-reference/trailer is incomplete')
    const imageObject = /\/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(pdfText)
    assert.ok(imageObject, 'PDF fallback does not contain its expected flattened RGB canvas image')
    assert.equal(Number(imageObject[1]), 1440); assert.equal(Number(imageObject[2]), 960)
    const imageStart = imageObject.index + imageObject[0].length
    const pixels = inflateSync(pdf.subarray(imageStart, imageStart + Number(imageObject[3])))
    assert.equal(pixels.length, 1440 * 960 * 3, 'PDF image pixel data was truncated')
    const pixelAt = (x, y) => Array.from(pixels.subarray((y * 1440 + x) * 3, (y * 1440 + x) * 3 + 3))
    assert.deepEqual(pixelAt(10, 10), [0xe8, 0xdf, 0xcd], 'PDF background color was not preserved')
    assert.deepEqual(pixelAt(1430, 950), [0xe8, 0xdf, 0xcd], 'PDF canvas edge/background was clipped')
    assert.notDeepEqual(pixelAt(150, 480), [0xe8, 0xdf, 0xcd], 'PDF image crop does not cover the left side of the photo bounds')
    assert.notDeepEqual(pixelAt(1290, 480), [0xe8, 0xdf, 0xcd], 'PDF image crop does not cover the right side of the photo bounds')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'), sourceHash, 'Source document changed during export')
    const leftovers = fs.readdirSync(root).filter((name) => name.endsWith('.tmp.ai'))
    assert.deepEqual(leftovers, [], 'Temporary Illustrator output was left behind')
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    results.fixture = 'passed: SVG/PDF alternatives, embedded JPEG crop, source SHA-256 unchanged, no temporary AI files'
    log(`RESULT fixture=PASS synthetic 1440x960 photo; source sha256=${sourceHash}; SVG/PDF fallbacks passed; no .tmp.ai files`)

    if (originalSvgPath) {
      const svgBytes = fs.readFileSync(originalSvgPath)
      const svgInput = svgBytes.toString('utf8')
      const originalSvgHash = crypto.createHash('sha256').update(svgBytes).digest('hex')
      assert.match(svgInput, /<svg\b/i, 'Original SVG input is not an SVG document')
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgInput, 'utf8').toString('base64')}`
      const rendered = await evaluate(`(async () => { const image = new Image(); image.src = ${JSON.stringify(dataUrl)}; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return { width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png').split(',')[1] } })()`)
      assert.ok(rendered?.width > 0 && rendered?.height > 0 && rendered?.png, 'Original SVG did not render to a PNG')
      if (originalRenderPath) {
        fs.mkdirSync(path.dirname(path.resolve(originalRenderPath)), { recursive: true })
        fs.writeFileSync(originalRenderPath, Buffer.from(rendered.png, 'base64'))
      }
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(originalSvgPath)).digest('hex'), originalSvgHash, 'Original SVG changed during rendering')
      results.originalSvg = `passed: separately rendered ${path.basename(originalSvgPath)} at ${rendered.width}x${rendered.height}; sha256=${originalSvgHash}; source unchanged${originalRenderPath ? `; PNG=${originalRenderPath}` : ''}`
      log(`RESULT original_svg=PASS source=${path.basename(originalSvgPath)} render=${rendered.width}x${rendered.height}${originalRenderPath ? ` png=${originalRenderPath}` : ''}`)
    } else {
      results.originalSvg = 'skipped: no NORTHSTAR_M8_SOURCE_SVG was provided'
      log('RESULT original_svg=SKIPPED no NORTHSTAR_M8_SOURCE_SVG was provided; synthetic fixture result is separate')
    }
    writeResults()
    if (/^(failed|cancelled|timed-out):/.test(results.illustrator)) throw new Error(`Illustrator automation ${results.illustrator}`)
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    await new Promise((resolve) => logStream.end(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(fs.existsSync(root), false, 'M8 temporary test directory was not removed')
    results.cleanup = 'passed: automation temp directory and per-run temp directory removed'
    writeResults()
  }
}

main().catch((error) => {
  results.fixture = results.fixture === 'pending' ? `failed: ${error.message}` : results.fixture
  if (results.illustrator === 'pending') results.illustrator = `failed: ${error.message}`
  if (results.originalSvg === 'not-provided' && originalSvgPath) results.originalSvg = `failed: ${error.message}`
  try {
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(fs.existsSync(root), false, 'M8 temporary test directory was not removed')
    results.cleanup = 'passed: per-run temp directory removed'
  } catch (cleanupError) {
    results.cleanup = `failed: ${cleanupError.message}`
    console.error(`[m8-ai-export-gui-smoke] Could not remove temporary directory: ${cleanupError.message}`)
  }
  try { writeResults() } catch (writeError) { console.error(`[m8-ai-export-gui-smoke] Could not write result report: ${writeError.message}`) }
  console.error(`[m8-ai-export-gui-smoke] FAILED: ${error.stack || error}`)
  process.exitCode = 1
})
