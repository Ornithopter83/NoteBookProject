const assert = require('node:assert/strict')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { writePsdBuffer } = require('ag-psd')

const appRoot = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m5-gui-'))
const sourcePath = path.join(root, 'source.psd')
const outputPath = path.join(root, 'edited.psd')
const blockedSourcePath = path.join(root, 'unsupported.psd')
const blockedOutputPath = path.join(root, 'unsupported-edited.psd')
const logPath = path.join(root, 'electron.log')
const sourceFixture = writePsdBuffer({ width: 8, height: 8, children: [{ name: '그룹', children: [{ name: '원본 레이어', left: 1, top: 2, opacity: 0.8, imageData: { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) } }] }] })
fs.writeFileSync(sourcePath, sourceFixture)
fs.writeFileSync(blockedSourcePath, writePsdBuffer({ width: 2, height: 2, children: [{ name: '효과 레이어', effects: { dropShadow: [{ enabled: true }] }, imageData: { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) } }] }))
const sourceHash = hashFile(sourcePath)

function hashFile(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }
function log(message) { console.log(`[m5-format-gui-smoke] ${message}`) }
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

async function runPsdGui(outputFile, scenario, inputFile = sourcePath) {
  let child, socket, id = 0
  const pending = new Map()
  const errors = []
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' })
  const electron = require('electron')
  const port = await freePort()
  child = spawn(electron, [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: inputFile, NORTHSTAR_GUI_SMOKE_PSD_FILE: outputFile }
  })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)
  try {
    const target = await targetAt(child, port)
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
    const cdp = (method, params = {}) => {
      const requestId = ++id
      return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
    }
    const evaluate = async (expression) => {
      const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result?.value
    }
    const waitFor = async (expression, description) => {
      const until = Date.now() + 10000
      while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
      throw new Error(`Timed out waiting for ${description}`)
    }
    const click = async (expression, description) => assert.equal(await evaluate(`(() => { const e = ${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${description}`)
    const setInput = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)

    await cdp('Runtime.enable'); await cdp('Log.enable')
    await waitFor("document.querySelector('.app-shell')", 'editor window')
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'open PSD')
    await waitFor("document.querySelector('[data-testid=psd-artboard] img')", 'PSD preview')
    const expectedLayerName = scenario === 'blocked-save' ? '효과 레이어' : '원본 레이어'
    await waitFor(`Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === ${JSON.stringify(expectedLayerName)})`, 'PSD layer tree')
    if (scenario === 'blocked-save') {
      const capability = await evaluate("document.querySelector('[data-testid=\"file-capability\"]')?.innerText")
      assert.match(capability, /현재 파일 차단 · 미지원 데이터/)
      assert.equal(await evaluate("document.querySelector('button.primary')?.disabled"), true, 'Save should be disabled when PSD data cannot be preserved')
      log('PASS unsupported PSD data is identified in the capability banner and save is disabled')
      return
    }
    if (scenario === 'reject-overwrite') {
      await click("document.querySelector('button.primary')", 'attempt source overwrite')
      await waitFor("document.querySelector('.canvas-status')?.innerText.includes('원본은 덮어쓸 수 없습니다')", 'source overwrite rejection')
      assert.equal(hashFile(sourcePath), sourceHash, 'Original PSD changed after rejected overwrite')
      log('PASS PSD overwrite rejected with a visible error; source hash remained unchanged')
      return
    }

    await click("Array.from(document.querySelectorAll('.layer-row')).find((row) => row.innerText.includes('원본 레이어'))", 'select PSD layer')
    assert.equal(await setInput('input[aria-label="레이어 이름"]', '편집된 레이어'), true)
    assert.equal(await setInput('input[aria-label="X"]', 4), true)
    assert.equal(await evaluate(`(() => { const e = document.querySelector('input[aria-label="레이어 불투명도"]'); if (!e) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, '45'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`), true)
    await click(`document.querySelector('button[aria-label="레이어 표시 전환"]')`, 'toggle PSD layer visibility')
    await waitFor("Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === '편집된 레이어')", 'edited PSD properties')
    await click("document.querySelector('button.primary')", 'save PSD copy')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('PSD를 저장했습니다')", 'PSD save')
    assert.ok(fs.existsSync(outputPath), 'PSD copy was not created')
    assert.equal(hashFile(sourcePath), sourceHash, 'Original PSD bytes changed after saving copy')
    const { openPsd } = await import('@northstar/psd-bridge')
    const saved = openPsd(fs.readFileSync(outputPath))
    const layer = saved.readTree()[0].children[0]
    assert.equal(layer.name, '편집된 레이어'); assert.equal(layer.left, 4); assert.equal(layer.visible, false)
    assert.ok(Math.abs(layer.opacity - 0.45) <= 1 / 255)
    assert.deepEqual(saved.getLayerPixels('0.0').data, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]), 'PSD raster data changed')
    await click("Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('열기'))", 'reopen edited PSD')
    await waitFor("Array.from(document.querySelectorAll('.layer-name')).some((e) => e.innerText === '편집된 레이어')", 'reopened PSD layer')
    await click("Array.from(document.querySelectorAll('.layer-row')).find((row) => row.innerText.includes('편집된 레이어'))", 'select reopened PSD layer')
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"레이어 이름\"]')?.value"), '편집된 레이어')
    assert.equal(await evaluate("Number(document.querySelector('input[aria-label=\"X\"]')?.value)"), 4)
    assert.equal(hashFile(sourcePath), sourceHash, 'Original PSD bytes changed after reopen')
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    log('PASS PSD edited, saved to a copy, reopened in GUI; layer data and original source hash verified')
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    logStream.end()
  }
}

async function main() {
  assert.match(execFileSync(require('electron'), ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  await runPsdGui(blockedOutputPath, 'blocked-save', blockedSourcePath)
  await runPsdGui(sourcePath, 'reject-overwrite')
  await runPsdGui(outputPath, 'save-copy')
  assert.equal(hashFile(sourcePath), sourceHash)
  const aiSmoke = spawnSync(process.execPath, [path.join(__dirname, 'm2-ai-gui-smoke.cjs')], { cwd: appRoot, stdio: 'inherit', env: process.env })
  if (aiSmoke.error) throw aiSmoke.error
  assert.equal(aiSmoke.status, 0, `AI PDF-compatible import/reopen smoke failed with exit ${aiSmoke.status}`)
  log('PASS PDF-compatible AI import, .nbdoc edit/save/reopen, and original AI hash/data preservation (M2 GUI scenario)')
}

main().catch((error) => { console.error(`[m5-format-gui-smoke] FAILED: ${error.stack || error}`); process.exitCode = 1 })
