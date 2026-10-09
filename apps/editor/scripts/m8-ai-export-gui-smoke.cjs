const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m8-ai-export-'))
const input = path.join(root, '사진 원본.nbdoc')
const output = { ai: path.join(root, '사진 결과.ai'), svg: path.join(root, '사진 대안.svg'), pdf: path.join(root, '사진 대안.pdf') }
const image = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Cf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Cf//aAAwDAQACAAMAAAAQ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k='
const source = { format: 'northstar-document', version: 1, name: '사진 원본', width: 1440, height: 960, background: '#e8dfcd', groups: [], nodes: [
  { id: 'photo', name: 'JPEG 사진', kind: 'image', x: 110, y: 90, width: 1220, height: 780, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/jpeg;base64,${image}`, visible: true, locked: false }
] }
fs.writeFileSync(input, JSON.stringify(source), 'utf8')
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex')
const logPath = path.join(root, 'electron.log')
function log(message) { console.log(`[m8-ai-export-gui-smoke] ${message}`) }
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

async function main() {
  assert.match(execFileSync(require('electron'), ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const port = await freePort()
  const child = spawn(require('electron'), [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: input, NORTHSTAR_GUI_SMOKE_OPEN_FILE: input,
      NORTHSTAR_GUI_SMOKE_EXPORT_AI: output.ai, NORTHSTAR_GUI_SMOKE_EXPORT_SVG: output.svg, NORTHSTAR_GUI_SMOKE_EXPORT_PDF: output.pdf }
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
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'editor canvas')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open source fixture')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')?.getAttribute('viewBox') === '0 0 1440 960'", '1440x960 fixture')
    const chooseExport = async (label) => {
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
      await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `${label} export`)
    }
    await chooseExport('Illustrator AI')
    const untilAi = Date.now() + 90000
    while (Date.now() < untilAi && !fs.existsSync(output.ai) && !(await evaluate("document.querySelector('.canvas-status')?.innerText.includes('설치되어 있지 않거나 COM 자동화를')"))) await new Promise((resolve) => setTimeout(resolve, 250))
    const { inspectAi } = await import('@northstar/ai-bridge')
    if (fs.existsSync(output.ai)) {
      const bytes = fs.readFileSync(output.ai); const report = inspectAi(bytes)
      assert.equal(report.status, 'pdf-compatible-ai', 'Output is not PDF-compatible native Illustrator AI')
      assert.equal(report.compatible, true)
      assert.ok(bytes.length > 100, 'AI output is empty')
      await waitFor("document.querySelector('.canvas-status')?.innerText.includes('Illustrator AI를 저장했습니다')", 'AI save and Illustrator reopen')
      log('PASS native .ai saved with PDF compatibility and reopened by Illustrator automation')
    } else {
      const status = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
      assert.match(status, /설치되어 있지 않거나 COM 자동화를 사용할 수 없습니다/)
      assert.match(status, /SVG\/PDF 내보내기/)
      assert.equal(fs.existsSync(output.ai), false, 'A fake AI file must not be produced when Illustrator is unavailable')
      log('PASS missing-Illustrator guidance; no fake .ai file was created')
    }
    await chooseExport('Illustrator용 SVG')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('SVG를 내보냈습니다')", 'SVG fallback')
    const svg = fs.readFileSync(output.svg, 'utf8')
    assert.match(svg, /width="1440"/); assert.match(svg, /height="960"/); assert.match(svg, /#e8dfcd/)
    assert.match(svg, /data:image\/jpeg;base64,/); assert.match(svg, /preserveAspectRatio="xMidYMid slice"/)
    await chooseExport('PDF 문서')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('PDF를 내보냈습니다')", 'PDF fallback')
    assert.match(fs.readFileSync(output.pdf, 'latin1'), /^%PDF-1\.4/)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'), sourceHash, 'Source document changed during export')
    const leftovers = fs.readdirSync(root).filter((name) => name.endsWith('.tmp.ai'))
    assert.deepEqual(leftovers, [], 'Temporary Illustrator output was left behind')
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS 1440x960 photo SVG/PDF fallbacks; embedded JPEG and crop preserved; source unchanged; no temporary AI files remain')
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    logStream.end()
  }
}

main().catch((error) => { console.error(`[m8-ai-export-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
