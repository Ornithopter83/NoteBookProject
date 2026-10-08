const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const appRoot = path.resolve(__dirname, '..')
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-gui-smoke-'))
const documentPath = path.join(smokeRoot, 'gui-smoke.nbdoc')
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
  console.log(`[m1-gui-smoke] ${message}`)
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
    if (await evaluate(expression)) return
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
    assert.ok(fs.existsSync(path.join(appRoot, 'out/preload/index.js')), 'Built preload entry is missing')
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

    await withStage('Object and layer editing', async () => {
      await click(`document.querySelector('.panel-menu')`, 'add layer')
      await waitFor(`document.querySelectorAll('.layer-row').length === 1`, 'new object and layer')
      await evaluate(`document.querySelector('.layer-row').click()`)
      const updated = await evaluate(`(() => {
        const input = document.querySelector('.property-content input.text-input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, 'GUI Smoke Layer')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      assert.equal(updated, true, 'Layer name property editor is missing')
      await waitFor(`document.querySelector('.layer-name')?.innerText === 'GUI Smoke Layer'`, 'edited layer name')
      assert.equal(await evaluate(`document.querySelectorAll('.artboard g[data-node="true"]').length`), 1, 'Canvas object was not rendered')
      assert.equal(await evaluate(`document.querySelector('.bottom-bar').innerText.includes('1개 오브젝트')`), true, 'Object count did not update')
    })

    await withStage('Undo and redo', async () => {
      await click(`document.querySelector('button[title="실행 취소"]')`, 'undo')
      await waitFor(`document.querySelector('.layer-name')?.innerText === '사각형 1'`, 'undo restoring the original layer name')
      await click(`document.querySelector('button[title="다시 실행"]')`, 'redo')
      await waitFor(`document.querySelector('.layer-name')?.innerText === 'GUI Smoke Layer'`, 'redo restoring the edited layer name')
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
      assert.equal(saved.nodes.length, 1)
      const savedNode = saved.nodes[0]
      assert.ok(savedNode.id.startsWith('layer-'))
      assert.deepEqual({
        kind: savedNode.kind,
        name: savedNode.name,
        x: savedNode.x,
        y: savedNode.y,
        width: savedNode.width,
        height: savedNode.height,
        fill: savedNode.fill,
        opacity: savedNode.opacity,
        rotation: savedNode.rotation,
        visible: savedNode.visible,
        locked: savedNode.locked
      }, {
        kind: 'rect', name: 'GUI Smoke Layer', x: 190, y: 160, width: 240, height: 180,
        fill: '#f7b955', opacity: 100, rotation: 0, visible: true, locked: false
      })

      const changedAgain = await evaluate(`(() => {
        const input = document.querySelector('.property-content input.text-input')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, 'Unsaved Change')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      assert.equal(changedAgain, true)
      await waitFor(`document.querySelector('.layer-name')?.innerText === 'Unsaved Change'`, 'unsaved edit before reopening')
      await click(`Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))`, 'open document')
      await waitFor(`document.querySelector('.layer-name')?.innerText === 'GUI Smoke Layer'`, 'reopened .nbdoc content')
      assert.equal(await evaluate(`document.querySelectorAll('.artboard g[data-node="true"]').length`), 1)
      await click(`document.querySelector('.layer-row')`, 'select reopened layer')
      assert.equal(await evaluate(`document.querySelector('.property-content input.text-input')?.value`), savedNode.name)
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.property-content input[type="number"]')).slice(0, 4).map((input) => Number(input.value))`), [savedNode.x, savedNode.y, savedNode.width, savedNode.height])
      assert.deepEqual(await evaluate(`(() => {
        const shape = document.querySelector('.artboard g[data-node="true"] > rect:not(.selection-outline)')
        return shape ? { x: Number(shape.getAttribute('x')), y: Number(shape.getAttribute('y')), width: Number(shape.getAttribute('width')), height: Number(shape.getAttribute('height')), fill: shape.getAttribute('fill') } : null
      })()`), { x: savedNode.x, y: savedNode.y, width: savedNode.width, height: savedNode.height, fill: savedNode.fill })
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
  console.error(`[m1-gui-smoke] FAILED at ${stage}: ${error.stack || error}`)
  process.exitCode = 1
})
