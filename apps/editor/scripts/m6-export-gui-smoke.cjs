const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m6-export-'))
const input = path.join(root, '작업 문서.nbdoc')
const output = Object.fromEntries(['png', 'jpeg', 'svg', 'pdf', 'psd'].map((format) => [format, path.join(root, `결과.${format === 'jpeg' ? 'jpg' : format}`)]))
const source = { format: 'northstar-document', version: 1, name: '내보내기 확인', width: 320, height: 200, background: '#f5f4f0', groups: [], nodes: [
  { id: 'rect', name: '도형', kind: 'rect', x: 20, y: 20, width: 100, height: 80, fill: '#f97352', opacity: 88, rotation: 12, visible: true, locked: false },
  { id: 'text', name: '한글', kind: 'text', x: 130, y: 45, width: 160, height: 55, fill: '#252629', opacity: 100, rotation: 0, text: '한글 내보내기', fontSize: 24, fontFamily: 'Arial', fontWeight: 600, visible: true, locked: false },
  { id: 'vector', name: '벡터 경로', kind: 'path', x: 24, y: 125, width: 90, height: 45, fill: '#2563eb', opacity: 100, rotation: 0, pathPaint: 'f', pathSegments: [{ op: 'M', points: [[24, 125]] }, { op: 'L', points: [[114, 125]] }, { op: 'L', points: [[70, 170]] }, { op: 'Z', points: [] }], visible: true, locked: false },
  { id: 'image', name: '내장 이미지', kind: 'image', x: 270, y: 130, width: 28, height: 28, fill: '#ffffff', opacity: 100, rotation: 0, src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', visible: true, locked: false },
  { id: 'hidden', name: '숨김', kind: 'rect', x: 200, y: 120, width: 30, height: 30, fill: '#00ff99', opacity: 100, rotation: 0, visible: false, locked: false }
] }
fs.writeFileSync(input, JSON.stringify(source), 'utf8')
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex')
const logPath = path.join(root, 'electron.log')
function log(message) { console.log(`[m6-export-gui-smoke] ${message}`) }
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
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: input, NORTHSTAR_GUI_SMOKE_OPEN_FILES: JSON.stringify([input, output.psd]),
      NORTHSTAR_GUI_SMOKE_EXPORT_PNG: output.png, NORTHSTAR_GUI_SMOKE_EXPORT_JPEG: output.jpeg, NORTHSTAR_GUI_SMOKE_EXPORT_SVG: output.svg,
      NORTHSTAR_GUI_SMOKE_EXPORT_PDF: output.pdf, NORTHSTAR_GUI_SMOKE_EXPORT_PSD: output.psd }
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
    const waitFor = async (expression, description) => { const until = Date.now() + 15000; while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error(`Timed out waiting for ${description}`) }
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'editor canvas')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open fixture document')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')?.getAttribute('viewBox') === '0 0 320 200'", '320x200 fixture document')
    await click("document.querySelector('.right-sidebar [data-node-id=rect]')", 'select fixture shape')
    await waitFor("document.querySelector('[data-testid=editor-artboard] .selection-outline')", 'visible selection outline')
    for (const format of ['png', 'jpeg', 'svg', 'pdf', 'psd']) {
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
      const label = ({ png: 'PNG 이미지', jpeg: 'JPEG 이미지', svg: 'Illustrator용 SVG', pdf: 'PDF 문서', psd: 'PSD 평면 문서' })[format]
      await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `${format} export`)
      await waitFor(`document.querySelector('.canvas-status')?.innerText.includes('${format.toUpperCase()}를 내보냈습니다')`, `${format} write`)
      assert.ok(fs.statSync(output[format]).size > 30, `${format} export is empty`)
    }
    const png = fs.readFileSync(output.png); assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 320); assert.equal(png.readUInt32BE(20), 200); assert.equal(png.toString('hex', -8), '49454e44ae426082')
    const jpeg = fs.readFileSync(output.jpeg); assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8); assert.ok(jpeg.includes(Buffer.from([0xff, 0xc0])) || jpeg.includes(Buffer.from([0xff, 0xc2])), 'JPEG frame header is missing')
    const svg = fs.readFileSync(output.svg, 'utf8'); assert.match(svg, /<svg/); assert.match(svg, /한글 내보내기/); assert.match(svg, /font-family="Arial"/); assert.match(svg, /rotate\(12 /); assert.match(svg, /data-canvas-path="true"/); assert.match(svg, /data:image\/gif;base64,/); assert.doesNotMatch(svg, /selection-outline|00ff99|data-node-id="hidden"/)
    assert.match(fs.readFileSync(output.pdf, 'latin1'), /^%PDF-1\.4/)
    const { openPsd } = await import('@northstar/psd-bridge')
    const exportedPsd = openPsd(fs.readFileSync(output.psd)); assert.equal(exportedPsd.width, 320); assert.equal(exportedPsd.height, 200); assert.equal(exportedPsd.bitDepth, 8)
    assert.deepEqual([...exportedPsd.getLayerPixels('0').data.slice(0, 4)], [245, 244, 240, 255])
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open exported PSD')
    await waitFor("document.querySelector('[data-testid=psd-artboard] img')", 'exported PSD reopened in GUI')
    assert.equal(fs.readFileSync(input).length > 0, true)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'), sourceHash, 'Source .nbdoc changed during export')
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS PNG/JPEG/SVG/PDF/8-bit RGB PSD exports; PSD reopened in editor GUI; source .nbdoc unchanged')
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    logStream.end()
  }
}

main().catch((error) => { console.error(`[m6-export-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
