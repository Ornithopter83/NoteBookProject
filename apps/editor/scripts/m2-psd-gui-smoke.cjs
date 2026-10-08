const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { writePsdBuffer } = require('ag-psd')

const appRoot = path.resolve(__dirname, '..')
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-psd-gui-'))
const psdPath = path.join(smokeRoot, 'gui-smoke.psd')
const logPath = path.join(smokeRoot, 'electron.log')
const fixture = writePsdBuffer({ width: 8, height: 8, children: [{ name: '스모크 그룹', children: [{ name: '원본 래스터', left: 1, top: 2, opacity: 0.8, imageData: { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) } }] }] })
fs.writeFileSync(psdPath, fixture)

let child, socket, childError, id = 0
const pending = new Map()
const errors = []
function log(message) { console.log(`[m2-psd-gui-smoke] ${message}`) }
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
async function setInput(selector, value) {
  return evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
}

async function main() {
  const { openPsd } = await import('@northstar/psd-bridge')
  const electron = require('electron')
  assert.match(execFileSync(electron, ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const port = await freePort()
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' })
  child = spawn(electron, [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: psdPath, NORTHSTAR_GUI_SMOKE_PSD_FILE: psdPath }
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
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'open PSD')
    await waitFor("document.querySelector('[data-testid=psd-artboard] img')", 'PSD raster preview')
    await waitFor("document.querySelectorAll('.layer-row').length === 2 && Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === '원본 래스터')", 'nested PSD layer tree')
    await click("Array.from(document.querySelectorAll('.layer-row')).find((row) => row.innerText.includes('원본 래스터'))", 'select raster layer')
    assert.equal(await setInput('input[aria-label="레이어 이름"]', '스모크 편집 레이어'), true)
    assert.equal(await setInput('input[aria-label="X"]', 4), true)
    assert.equal(await evaluate(`(() => { const e = document.querySelector('input[aria-label="레이어 불투명도"]'); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, '45'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`), true)
    await click(`document.querySelector('button[aria-label="레이어 표시 전환"]')`, 'toggle layer visibility')
    await waitFor("Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === '스모크 편집 레이어')", 'edited PSD properties')
    await click("document.querySelector('button.primary')", 'save PSD')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('PSD를 저장했습니다')", 'PSD save completion')
    const savedBytes = fs.readFileSync(psdPath)
    const saved = openPsd(savedBytes)
    const savedTree = saved.readTree()
    assert.equal(savedTree[0].name, '스모크 그룹')
    assert.equal(savedTree[0].children[0].name, '스모크 편집 레이어')
    assert.equal(savedTree[0].children[0].left, 4)
    assert.equal(savedTree[0].children[0].visible, false)
    assert.ok(Math.abs(savedTree[0].children[0].opacity - 0.45) <= 1 / 255)
    assert.deepEqual(saved.getLayerPixels('0.0').data, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]))

    await setInput('input[aria-label="레이어 이름"]', '저장하지 않을 이름')
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'reopen saved PSD')
    await waitFor("Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === '스모크 편집 레이어')", 'reopened layer name')
    assert.equal(await evaluate("document.querySelector('[data-testid=psd-artboard] img')?.style.display"), 'none', 'Layer visibility did not survive PSD reopen')
    await click("Array.from(document.querySelectorAll('.layer-row')).find((row) => row.innerText.includes('스모크 편집 레이어'))", 'select reopened layer')
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"레이어 이름\"]')?.value"), '스모크 편집 레이어')
    assert.equal(await evaluate("Number(document.querySelector('input[aria-label=\"X\"]')?.value)"), 4)
    assert.equal(await evaluate("Number(document.querySelector('input[aria-label=\"레이어 불투명도\"]')?.value)"), 45)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS PSD opened, raster and hierarchy rendered, layer edits saved and verified, then reopened in GUI')
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

main().catch((error) => { console.error(`[m2-psd-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
