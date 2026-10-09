const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const appRoot = path.resolve(__dirname, '..')
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m3-gui-smoke-'))
const documentPath = path.join(smokeRoot, 'm3-gui-smoke.nbdoc')
const logPath = path.join(smokeRoot, 'electron.log')
let stage = 'Electron installation'
let electronBin
let child
let childError
let socket
let nextId = 0
const pending = new Map()
const browserErrors = []

function log(message) {
  console.log(`[m3-editor-gui-smoke] ${message}`)
}

async function withStage(name, action) {
  stage = name
  log(`START ${name}`)
  try {
    await action()
    log(`PASS ${name}`)
  } catch (error) {
    log(`FAIL ${name}: ${error.stack || error}`)
    throw error
  }
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (childError) throw childError
    if (child.exitCode !== null) throw new Error(`Electron exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for the Electron renderer target${lastError ? `: ${lastError}` : ''}`)
}

function connectDebugger(url) {
  socket = new WebSocket(url)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('CDP WebSocket closed'))
    pending.clear()
  })
  return once(socket, 'open')
}

function cdp(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}

async function waitFor(expression, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function click(expression, description) {
  const clicked = await evaluate(`(() => { const element = ${expression}; if (!element || element.disabled) return false; element.click(); return true })()`)
  assert.equal(clicked, true, `Could not click ${description}`)
}

function closeSocket() {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
}

async function main() {
  await withStage('Electron installation', async () => {
    electronBin = require('electron')
    const version = execFileSync(electronBin, ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim()
    assert.match(version, /^v\d+\./, `Unexpected Electron version output: ${version}`)
    log(`Electron ${version} at ${electronBin}`)
    assert.ok(fs.existsSync(path.join(appRoot, 'out/main/index.js')), 'Built main process entry is missing')
    assert.ok(fs.existsSync(path.join(appRoot, 'out/preload/index.cjs')), 'Built preload entry is missing')
    assert.ok(fs.existsSync(path.join(appRoot, 'out/renderer/index.html')), 'Built renderer HTML is missing')
  })

  const port = await freePort()
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' })
  child = spawn(electronBin, [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot,
    windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: documentPath }
  })
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)
  child.on('error', (error) => {
    childError = error
    log(`Electron process error: ${error.stack || error}`)
  })

  try {
    await withStage('React renderer mount', async () => {
      const target = await waitForTarget(port)
      await connectDebugger(target.webSocketDebuggerUrl)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.method === 'Runtime.bindingCalled' && message.params.name === '__northstarSmokeConsoleError') browserErrors.push(message.params.payload)
        if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails?.text || 'Uncaught renderer exception')
        if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') browserErrors.push(message.params.entry.text)
      })
      await cdp('Runtime.enable')
      await cdp('Log.enable')
      await cdp('Runtime.addBinding', { name: '__northstarSmokeConsoleError' })
      await cdp('Page.enable')
      await cdp('Page.addScriptToEvaluateOnNewDocument', {
        source: `console.error = (...args) => window.__northstarSmokeConsoleError(args.map(String).join(' '))`
      })
      await cdp('Page.reload', { ignoreCache: true })
      await waitFor(`document.querySelector('.app-shell') && document.querySelector('.brand')?.innerText.includes('northstar')`, 'React app shell')
      const text = await evaluate(`document.querySelector('.app-shell').innerText`)
      assert.match(text, /레이어/)
      log('React app shell and editor panels are mounted')
    })

    await withStage('Multi-select, group, precision transform, text editing', async () => {
      await click(`document.querySelector('.panel-menu')`, 'add layer')
      await click(`document.querySelector('.panel-menu')`, 'add second layer')
      await waitFor(`document.querySelectorAll('.layer-row').length === 2`, 'two objects and layers')
      await evaluate(`(() => { const rows = document.querySelectorAll('.layer-row'); rows[0].click(); rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) })()`)
      await waitFor(`document.querySelectorAll('.layer-row.selected').length === 2`, 'multi-selection')
      await click(`Array.from(document.querySelectorAll('.group-actions button')).find((button) => button.title === '선택 항목 그룹화')`, 'group selected layers')
      await waitFor(`document.querySelectorAll('.layer-row[data-group-id]').length === 1`, 'group layer')
      await click(`document.querySelector('.layer-row[data-group-id]')`, 'select group')
      await waitFor(`document.querySelector('[data-testid="group-properties"]')`, 'group transform controls')
      await evaluate(`(() => { const e = document.querySelector('[data-testid="group-properties"] input[aria-label="W"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '520.5'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
      await evaluate(`(() => { const e = document.querySelector('[data-testid="group-properties"] input[aria-label="회전"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '17.5'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
      assert.equal(await evaluate(`Number(document.querySelector('[data-testid="group-properties"] input[aria-label="W"]').value)`), 520.5, 'Group width was not applied precisely')
      assert.equal(await evaluate(`Number(document.querySelector('[data-testid="group-properties"] input[aria-label="회전"]').value)`), 17.5, 'Group rotation was not applied precisely')
      const transformedRects = await evaluate(`(() => Array.from(document.querySelectorAll('.artboard g[data-node="true"]')).map((group) => { const rect = group.querySelector('rect'); return rect ? { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')), width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')), transform: group.getAttribute('transform') } : null }))()`)
      const sx = 520.5 / 264
      const angle = 17.5 * Math.PI / 180
      const expectedWidth = 240 * sx
      const expectedCenters = [[-12 * sx, -9], [12 * sx, 9]].map(([x, y]) => [450.25 + x * Math.cos(angle) - y * Math.sin(angle), 259 + x * Math.sin(angle) + y * Math.cos(angle)])
      assert.equal(transformedRects.length, 2, 'Expected both grouped rectangles to remain on the canvas')
      for (let index = 0; index < transformedRects.length; index++) {
        const rect = transformedRects[index]
        assert.ok(Math.abs(rect.x - (expectedCenters[index][0] - expectedWidth / 2)) < 0.01, `Grouped rectangle ${index + 1} X transform is inaccurate`)
        assert.ok(Math.abs(rect.y - (expectedCenters[index][1] - 90)) < 0.01, `Grouped rectangle ${index + 1} Y transform is inaccurate`)
        assert.ok(Math.abs(rect.width - expectedWidth) < 0.01, `Grouped rectangle ${index + 1} width transform is inaccurate`)
        const rotation = rect.transform.match(/^rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)$/)
        assert.ok(rotation, `Grouped rectangle ${index + 1} rotation transform is missing`)
        assert.equal(Number(rotation[1]), 17.5, `Grouped rectangle ${index + 1} rotation was not applied exactly`)
        assert.ok(Math.abs(Number(rotation[2]) - expectedCenters[index][0]) < 0.01, `Grouped rectangle ${index + 1} rotation pivot X is inaccurate`)
        assert.ok(Math.abs(Number(rotation[3]) - expectedCenters[index][1]) < 0.01, `Grouped rectangle ${index + 1} rotation pivot Y is inaccurate`)
      }
      await click(`document.querySelector('button[title="실행 취소"]')`, 'undo group rotation')
      await waitFor(`Number(document.querySelector('[data-testid="group-properties"] input[aria-label="회전"]')?.value) === 0`, 'undoing precise group rotation')
      await click(`document.querySelector('button[title="다시 실행"]')`, 'redo group rotation')
      await waitFor(`Number(document.querySelector('[data-testid="group-properties"] input[aria-label="회전"]')?.value) === 17.5`, 'redoing precise group rotation')
      await click(`document.querySelector('.layer-row[data-group-id] button[title="숨기기"]')`, 'hide group')
      await waitFor(`document.querySelectorAll('.artboard g[data-node="true"]').length === 0`, 'group visibility hiding all members')
      await click(`document.querySelector('.layer-row[data-group-id] button[title="표시하기"]')`, 'show group')
      await waitFor(`document.querySelectorAll('.artboard g[data-node="true"]').length === 2`, 'group visibility restoring all members')
      await click(`document.querySelector('.layer-row[data-group-id] button[title="잠금"]')`, 'lock group')
      await evaluate(`(() => { const e = document.querySelector('[data-testid="group-properties"] input[aria-label="W"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '521'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
      await click(`document.querySelector('.layer-row[data-group-id] button[title="숨기기"]')`, 'hide locked group')
      await waitFor(`document.querySelectorAll('.artboard g[data-node="true"]').length === 0`, 'locked group visibility toggle')
      assert.equal(await evaluate(`Number(document.querySelector('[data-testid="group-properties"] input[aria-label="W"]').value)`), 520.5, 'Locked group accepted a transform')
      await click(`document.querySelector('.layer-row[data-group-id] button[title="표시하기"]')`, 'show locked group')
      await waitFor(`document.querySelectorAll('.artboard g[data-node="true"]').length === 2`, 'showing locked group')
      await click(`document.querySelector('.layer-row[data-group-id] button[title="잠금 해제"]')`, 'unlock group')
      await click(`Array.from(document.querySelectorAll('.canvas-tools button')).find((button) => button.title === '텍스트 추가')`, 'add text')
      await waitFor(`document.querySelector('textarea[aria-label="텍스트 내용"]')`, 'text properties')
      await evaluate(`(() => { const e = document.querySelector('textarea[aria-label="텍스트 내용"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, 'M3 GUI 편집 테스트'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
      await waitFor(`document.querySelector('textarea[aria-label="텍스트 내용"]')?.value === 'M3 GUI 편집 테스트'`, 'Unicode text editing')
      assert.equal(await evaluate(`document.querySelectorAll('.artboard g[data-node="true"]').length`), 3, 'Canvas objects were not rendered')
    })

    await withStage('.nbdoc save and reopen', async () => {
      await click(`document.querySelector('button.primary')`, 'save document')
      await waitFor(`document.querySelector('.canvas-status')?.innerText.includes('모든 변경 사항이 저장되었습니다')`, 'save completion')
      await waitFor(`document.querySelector('.layer-row')`, 'saved layer')
      assert.ok(fs.existsSync(documentPath), 'The .nbdoc file was not written')
      const saved = JSON.parse(fs.readFileSync(documentPath, 'utf8'))
      assert.equal(saved.format, 'northstar-document')
      assert.equal(saved.version, 1)
      assert.equal(saved.width, 1440)
      assert.equal(saved.height, 960)
      assert.equal(saved.background, '#f5f4f0')
      assert.equal(saved.nodes.length, 3)
      assert.equal(saved.groups.length, 1)
      assert.equal(saved.groups[0].width, 520.5)
      assert.equal(saved.groups[0].rotation, 17.5)
      assert.equal(saved.groups[0].nodeIds.length, 2)
      assert.equal(saved.nodes.find((node) => node.kind === 'text').text, 'M3 GUI 편집 테스트')

      const changedAgain = await evaluate(`(() => { const e = document.querySelector('textarea[aria-label="텍스트 내용"]'); if (!e) return false; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, 'Unsaved Change'); e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      assert.equal(changedAgain, true)
      await waitFor(`document.querySelector('textarea[aria-label="텍스트 내용"]')?.value === 'Unsaved Change'`, 'unsaved edit before reopening')
      await click(`Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))`, 'open document')
      await waitFor(`document.querySelectorAll('.artboard g[data-node="true"]').length === 3`, 'reopened .nbdoc objects')
      assert.equal(await evaluate(`document.querySelectorAll('.layer-row[data-group-id]').length`), 1, 'Group was not restored')
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.artboard text')).some((node) => node.textContent === 'M3 GUI 편집 테스트')`), true, 'Edited Unicode text was not restored')
    })

    await withStage('Undo and redo grouping after reopen', async () => {
      await click(`document.querySelector('.layer-row[data-group-id]')`, 'select restored group')
      await click(`Array.from(document.querySelectorAll('.group-actions button')).find((button) => button.title === '그룹 해제')`, 'ungroup layers')
      await waitFor(`document.querySelectorAll('.layer-row[data-group-id]').length === 0`, 'ungrouped layers')
      await click(`document.querySelector('button[title="실행 취소"]')`, 'undo')
      await waitFor(`document.querySelectorAll('.layer-row[data-group-id]').length === 1`, 'undo restoring grouping')
      await click(`document.querySelector('button[title="다시 실행"]')`, 'redo')
      await waitFor(`document.querySelectorAll('.layer-row[data-group-id]').length === 0`, 'redo restoring ungrouping')
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(browserErrors, [], `Renderer reported errors: ${browserErrors.join(' | ')}`)
    log('No renderer exceptions or console errors were reported')
  } catch (error) {
    log(`FAIL ${stage}: ${error.stack || error}`)
    if (fs.existsSync(logPath)) log(`Electron log follows:\n${fs.readFileSync(logPath, 'utf8')}`)
    throw error
  } finally {
    closeSocket()
    if (child && child.exitCode === null) {
      child.kill()
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))])
    }
    logStream.end()
  }
}

main().catch((error) => {
  console.error(`[m3-editor-gui-smoke] FAILED at ${stage}: ${error.stack || error}`)
  process.exitCode = 1
})
