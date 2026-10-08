const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-ai-gui-'))
const aiPath = path.join(smokeRoot, 'vector-text.ai')
const nbdocPath = path.join(smokeRoot, 'vector-text.nbdoc')
const logPath = path.join(smokeRoot, 'electron.log')

let child, socket, childError, id = 0
const pending = new Map()
const errors = []
function log(message) { console.log(`[m2-ai-gui-smoke] ${message}`) }
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
async function targetAt(port) {
  const until = Date.now() + 30000
  while (Date.now() < until) {
    if (childError) throw childError
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
function cdp(method, params = {}) {
  const requestId = ++id
  return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result?.value
}
async function waitFor(expression, description) {
  const until = Date.now() + 10000
  while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(`Timed out waiting for ${description}`)
}
async function click(expression, description) {
  assert.equal(await evaluate(`(() => { const e = ${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${description}`)
}
async function setValue(selector, value, tag = 'input') {
  return evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(${tag === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set; setter.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
}

async function main() {
  const { writePdf } = await import('@northstar/ai-bridge')
  const fixture = writePdf({
    format: 'pdf-compatible-ai-subset', pdfVersion: '1.4', pages: [{ width: 240, height: 180, items: [
      { type: 'path', segments: [
        { op: 'M', points: [[20, 25]] }, { op: 'L', points: [[110, 25]] },
        { op: 'C', points: [[130, 30], [135, 80], [95, 95]] },
        { op: 'L', points: [[20, 90]] }, { op: 'Z', points: [] }
      ], paint: 'B*' },
      { type: 'text', text: 'AI Bridge GUI', position: [30, 140], fontSize: 18 }
    ] }] })
  fs.writeFileSync(aiPath, fixture)
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(aiPath)).digest('hex')
  const electron = require('electron')
  assert.match(execFileSync(electron, ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const port = await freePort()
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' })
  child = spawn(electron, [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_AI_FILE: aiPath, NORTHSTAR_GUI_SMOKE_FILE: nbdocPath }
  })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)
  child.on('error', (error) => { childError = error })
  try {
    const target = await targetAt(port)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const request = pending.get(message.id)
        if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) }
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Renderer exception')
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
    })
    await once(socket, 'open')
    await cdp('Runtime.enable'); await cdp('Log.enable')
    await waitFor("document.querySelector('.app-shell')", 'editor window')
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'open AI')
    await waitFor("document.querySelector('[data-testid=ai-artboard] path') && document.querySelector('[data-testid=ai-import-warning]')", 'AI path and disclosure')
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=ai-artboard] path').length"), 1)
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('fill-rule')"), 'evenodd')
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] text')?.textContent"), 'AI Bridge GUI')
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('d')"), 'M 20 155 L 110 155 C 130 150 135 100 95 85 L 20 90 Z')

    const pathCenter = await evaluate("(() => { const r = document.querySelector('[data-testid=ai-artboard] path').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()")
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pathCenter.x, y: pathCenter.y, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pathCenter.x, y: pathCenter.y, button: 'left', clickCount: 1 })
    await waitFor("document.querySelector('[data-testid=ai-artboard] .selection-outline')", 'select path on canvas')
    assert.equal(await setValue('input[aria-label="X"]', 25), true)
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('d')?.startsWith('M 25 155')"), true, 'Vector path edit was not reflected in the canvas')

    await click("Array.from(document.querySelectorAll('.layer-row')).find((row) => row.innerText.includes('AI 텍스트'))", 'select imported text')
    assert.equal(await setValue('.text-area', 'Edited AI text', 'textarea'), true)
    await click("document.querySelector('button.primary')", 'save converted document')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('AI 변환 문서를 .nbdoc로 저장했습니다')", 'nbdoc save')
    assert.ok(fs.existsSync(nbdocPath), 'Converted .nbdoc was not written')
    const saved = JSON.parse(fs.readFileSync(nbdocPath, 'utf8'))
    assert.equal(saved.width, 240); assert.equal(saved.height, 180)
    assert.equal(saved.nodes[0].kind, 'path'); assert.equal(saved.nodes[0].pathPaint, 'B*')
    assert.deepEqual(saved.nodes[0].pathSegments[2], { op: 'C', points: [[135, 30], [140, 80], [100, 95]] })
    assert.equal(saved.nodes[1].kind, 'aiText'); assert.equal(saved.nodes[1].text, 'Edited AI text')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(aiPath)).digest('hex'), originalHash, 'Original AI bytes changed')

    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'reopen saved .nbdoc')
    await waitFor("document.querySelector('[data-testid=editor-artboard] path') && document.querySelector('[data-testid=editor-artboard] text')?.textContent === 'Edited AI text'", 'reopened .nbdoc contents')
    assert.equal(await evaluate("document.querySelector('[data-testid=editor-artboard] path')?.getAttribute('fill-rule')"), 'evenodd')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS actual one-page AI opened, vector paint/geometry and ASCII text rendered, edited, saved as .nbdoc, reopened, and source AI remained byte-identical')
  } catch (error) {
    log(`FAIL: ${error.stack || error}`)
    if (fs.existsSync(logPath)) log(fs.readFileSync(logPath, 'utf8'))
    throw error
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    logStream.end()
  }
}

main().catch((error) => { console.error(`[m2-ai-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
