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
    if (child && child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`)
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

async function canvasPathHit() {
  return evaluate(`(() => {
    const svg = document.querySelector('[data-testid="ai-artboard"]')
    const path = svg?.querySelector('[data-canvas-path]')
    if (!svg || !path) return { error: 'AI SVG path is missing' }
    const box = path.getBBox()
    const matrix = path.getScreenCTM()
    const svgPoint = svg.createSVGPoint()
    const candidates = []
    for (let row = 1; row < 20; row++) for (let column = 1; column < 20; column++) {
      const x = box.x + box.width * column / 20
      const y = box.y + box.height * row / 20
      const local = new DOMPoint(x, y)
      let inFill = false
      try { inFill = path.isPointInFill(local) } catch {}
      if (!inFill) continue
      svgPoint.x = x; svgPoint.y = y
      const screen = svgPoint.matrixTransform(matrix)
      const hit = document.elementFromPoint(screen.x, screen.y)
      candidates.push({ x, y, clientX: screen.x, clientY: screen.y, hit: hit?.tagName, hitNodeId: hit?.closest('[data-node]')?.getAttribute('data-node-id') ?? null })
      if (hit === path || path.contains(hit)) return { ...candidates[candidates.length - 1], rect: path.getBoundingClientRect().toJSON(), bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, pointerEvents: getComputedStyle(path).pointerEvents, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, candidates: candidates.length }
    }
    return { error: 'No painted path point is the DOM hit target', rect: path.getBoundingClientRect().toJSON(), bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, pointerEvents: getComputedStyle(path).pointerEvents, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, candidates: candidates.slice(0, 12) }
  })()`)
}

async function canvasTextHit() {
  return evaluate(`(() => {
    const svg = document.querySelector('[data-testid="ai-artboard"]')
    const text = svg?.querySelector('text')
    if (!svg || !text) return { error: 'AI SVG text is missing' }
    const box = text.getBBox()
    const matrix = text.getScreenCTM()
    const svgPoint = svg.createSVGPoint()
    const candidates = []
    for (let row = 1; row < 10; row++) for (let column = 1; column < 30; column++) {
      const x = box.x + box.width * column / 30
      const y = box.y + box.height * row / 10
      svgPoint.x = x; svgPoint.y = y
      const screen = svgPoint.matrixTransform(matrix)
      const hit = document.elementFromPoint(screen.x, screen.y)
      candidates.push({ x, y, clientX: screen.x, clientY: screen.y, hit: hit?.tagName, hitNodeId: hit?.closest('[data-node]')?.getAttribute('data-node-id') ?? null })
      if (hit === text || text.contains(hit)) return { ...candidates[candidates.length - 1], rect: text.getBoundingClientRect().toJSON(), bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } }
    }
    return { error: 'No visible text point is the DOM hit target', rect: text.getBoundingClientRect().toJSON(), bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, candidates: candidates.slice(0, 12) }
  })()`)
}

async function canvasFailureState() {
  return evaluate(`(() => {
    const svg = document.querySelector('[data-testid="ai-artboard"]')
    const path = svg?.querySelector('[data-canvas-path]')
    const outline = svg?.querySelector('.selection-outline')
    const rect = path?.getBoundingClientRect()
    const point = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
    const hit = point ? document.elementFromPoint(point.x, point.y) : null
    return { selectedLayer: document.querySelector('.layer-row.selected')?.innerText ?? null, selectedObjectId: svg?.querySelector('.selection-outline')?.parentElement?.getAttribute('data-node-id') ?? null, outline: Boolean(outline), clickPoint: point, hit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className?.baseVal ?? hit.className ?? ''), nodeId: hit.closest?.('[data-node]')?.getAttribute('data-node-id') ?? null } : null, pointerTrace: window.__canvasPointerTrace ?? [], path: path ? { d: path.getAttribute('d'), fill: path.getAttribute('fill'), fillRule: path.getAttribute('fill-rule'), pointerEvents: getComputedStyle(path).pointerEvents, rect: rect.toJSON(), bbox: (() => { const b = path.getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height } })() } : null, svg: svg ? { rect: svg.getBoundingClientRect().toJSON(), viewBox: svg.getAttribute('viewBox'), pointerEvents: getComputedStyle(svg).pointerEvents } : null, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } }
  })()`)
}

async function main() {
  const { inspectAi, writePdf } = await import('@northstar/ai-bridge')
  const fixture = Buffer.from(writePdf({
    format: 'pdf-compatible-ai-subset', pdfVersion: '1.4', pages: [{ width: 240, height: 180, items: [
      { type: 'path', segments: [
        { op: 'M', points: [[20, 25]] }, { op: 'L', points: [[110, 25]] },
        { op: 'C', points: [[130, 30], [135, 80], [95, 95]] },
        { op: 'L', points: [[20, 90]] }, { op: 'Z', points: [] }
      ], paint: 'B*' },
      { type: 'text', text: 'AI Bridge GUI', position: [30, 140], fontSize: 18 }
    ] }] }).toString('ascii').replace('%AI-Bridge-Subset', '%AI1Bridge-Subset'), 'ascii')
  assert.equal(inspectAi(fixture).status, 'pdf-compatible-ai', 'AI smoke fixture must carry a validated Illustrator marker')
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
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Electron CDP WebSocket')), 10000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', (event) => { clearTimeout(timeout); reject(new Error(`Electron CDP WebSocket failed: ${event.message || 'connection error'}`)) }, { once: true })
    })
    await cdp('Runtime.enable'); await cdp('Log.enable')
    await waitFor("document.querySelector('.app-shell')", 'editor window')
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'open AI')
    await waitFor("document.querySelector('[data-testid=ai-artboard] path') && document.querySelector('[data-testid=ai-import-warning]')", 'AI path and disclosure')
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=ai-artboard] path').length"), 1)
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('fill-rule')"), 'evenodd')
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] text')?.textContent"), 'AI Bridge GUI')
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('d')"), 'M 20 155 L 110 155 C 130 150 135 100 95 85 L 20 90 Z')

    const pathHit = await canvasPathHit()
    assert.ok(!pathHit.error, `Could not find an actual painted canvas hit point: ${JSON.stringify(pathHit)}`)
    log(`Canvas path hit point: ${JSON.stringify(pathHit)}`)
    await evaluate(`(() => { const svg = document.querySelector('[data-testid="ai-artboard"]'); window.__canvasPointerTrace = []; for (const type of ['pointerdown', 'pointerup', 'click']) svg.addEventListener(type, (event) => window.__canvasPointerTrace.push({ type, pointerType: event.pointerType ?? null, button: event.button, clientX: event.clientX, clientY: event.clientY, target: event.target?.tagName, nodeId: event.target?.closest?.('[data-node]')?.getAttribute('data-node-id') ?? null, defaultPrevented: event.defaultPrevented }), true) })()`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pathHit.clientX, y: pathHit.clientY, button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pathHit.clientX, y: pathHit.clientY, button: 'left', clickCount: 1 })
    try { await waitFor("window.__canvasPointerTrace.some((event) => event.type === 'pointerdown')", 'canvas PointerEvent delivery') }
    catch (error) {
      log(`Canvas PointerEvent diagnostic: ${JSON.stringify(await canvasFailureState())}`)
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pathHit.clientX, y: pathHit.clientY, button: 'left', clickCount: 1 })
      throw error
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pathHit.clientX, y: pathHit.clientY, button: 'left', clickCount: 1 })
    try { await waitFor("document.querySelector('[data-testid=ai-artboard] .selection-outline')", 'select path on canvas') }
    catch (error) { log(`Canvas selection diagnostic: ${JSON.stringify(await canvasFailureState())}`); throw error }
    assert.ok(await evaluate("document.querySelector('[data-testid=ai-artboard] .selection-outline')?.parentElement?.matches('[data-node-id]')"), 'Canvas click did not select an SVG node')
    assert.ok(await evaluate("window.__canvasPointerTrace.some((event) => event.type === 'pointerdown' && event.nodeId === document.querySelector('[data-testid=ai-artboard] .selection-outline')?.parentElement?.getAttribute('data-node-id'))"), `CDP click did not deliver PointerEvent to the selected canvas path: ${JSON.stringify(await canvasFailureState())}`)
    assert.ok(await evaluate("window.__canvasPointerTrace.some((event) => event.type === 'pointerup')"), `CDP click did not complete its PointerEvent sequence: ${JSON.stringify(await canvasFailureState())}`)
    assert.equal(await setValue('input[aria-label="X"]', 25), true)
    assert.equal(await evaluate("document.querySelector('[data-testid=ai-artboard] path')?.getAttribute('d')?.startsWith('M 25 155')"), true, 'Vector path edit was not reflected in the canvas')

    const textHit = await canvasTextHit()
    assert.ok(!textHit.error, `Could not find a visible canvas text hit point: ${JSON.stringify(textHit)}`)
    log(`Canvas text hit point: ${JSON.stringify(textHit)}`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: textHit.clientX, y: textHit.clientY, button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: textHit.clientX, y: textHit.clientY, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: textHit.clientX, y: textHit.clientY, button: 'left', clickCount: 1 })
    try { await waitFor("document.querySelector('[data-testid=ai-artboard] .selection-outline')?.parentElement?.querySelector('text')", 'select text on canvas') }
    catch (error) { log(`Canvas text selection diagnostic: ${JSON.stringify(await canvasFailureState())}`); throw error }
    assert.ok(await evaluate("window.__canvasPointerTrace.some((event) => event.type === 'pointerdown' && event.nodeId === document.querySelector('[data-testid=ai-artboard] .selection-outline')?.parentElement?.getAttribute('data-node-id'))"), `Canvas click did not deliver PointerEvent to the selected text: ${JSON.stringify(await canvasFailureState())}`)
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
    assert.equal(await evaluate("document.querySelector('[data-testid=editor-artboard] path')?.getAttribute('d')"), 'M 25 155 L 115 155 C 135 150 140 100 100 85 L 25 90 Z', 'Reopened vector coordinates changed')
    assert.equal(await evaluate("document.querySelector('[data-testid=editor-artboard] path')?.getAttribute('fill')"), saved.nodes[0].fill, 'Reopened vector fill changed')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(aiPath)).digest('hex'), originalHash, 'Original AI bytes changed after reopen')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS actual one-page AI opened, vector paint/geometry and ASCII text rendered, edited, saved as .nbdoc, reopened, and source AI remained byte-identical')
  } catch (error) {
    log(`FAIL: ${error.stack || error}`)
    try { log(`Failure DOM state: ${JSON.stringify(await canvasFailureState())}`) } catch {}
    if (fs.existsSync(logPath)) log(fs.readFileSync(logPath, 'utf8'))
    throw error
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    logStream.end()
  }
}

main().catch((error) => { console.error(`[m2-ai-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
