const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const repoRoot = path.resolve(__dirname, '../../..')
const launcher = path.join(repoRoot, 'RUN-NORTHSTAR.bat')
const packagedExecutable = path.join(repoRoot, 'apps', 'editor', 'release', 'win-unpacked', 'Northstar Editor.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m9-root-launch-'))
const fixturePath = path.join(tempRoot, 'M9 smoke.nbdoc')
const fixture = { format: 'northstar-document', version: 1, name: 'M9 현재 소스 확인', width: 960, height: 640, background: '#e8dfcd', groups: [], nodes: [] }
fs.writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8')
let launcherOutput = ''
let launcherError = null
let legacyPackageState = 'not-seeded'
const sourceBuildMarkers = new Set()
let seededLegacyExecutable = false
let createdUnpackedDirectory = false
let createdReleaseDirectory = false

function seedLegacyPackageSentinel() {
  if (fs.existsSync(packagedExecutable)) return 'existing'
  const unpackedDirectory = path.dirname(packagedExecutable)
  const releaseDirectory = path.dirname(unpackedDirectory)
  if (!fs.existsSync(releaseDirectory)) {
    fs.mkdirSync(releaseDirectory)
    createdReleaseDirectory = true
  }
  if (!fs.existsSync(unpackedDirectory)) {
    fs.mkdirSync(unpackedDirectory)
    createdUnpackedDirectory = true
  }
  const descriptor = fs.openSync(packagedExecutable, 'wx')
  seededLegacyExecutable = true
  try { fs.writeFileSync(descriptor, 'M9 stale package sentinel; this must never be launched.\n', 'utf8') }
  finally { fs.closeSync(descriptor) }
  return 'sentinel'
}

function cleanupLegacyPackageSentinel() {
  if (seededLegacyExecutable) fs.rmSync(packagedExecutable, { force: true })
  const unpackedDirectory = path.dirname(packagedExecutable)
  const releaseDirectory = path.dirname(unpackedDirectory)
  if (createdUnpackedDirectory) {
    try { fs.rmdirSync(unpackedDirectory) } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error }
  }
  if (createdReleaseDirectory) {
    try { fs.rmdirSync(releaseDirectory) } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error }
  }
}

function collectLauncherOutput(chunk) {
  const combined = launcherOutput + chunk
  for (const marker of ['Building PSD Bridge...', 'Building Northstar Editor...', 'Starting Northstar Editor...']) {
    if (combined.includes(marker)) sourceBuildMarkers.add(marker)
  }
  launcherOutput = combined.slice(-12000)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForRenderer(child, port) {
  const until = Date.now() + 5 * 60_000
  while (Date.now() < until) {
    if (launcherError) throw new Error(`Could not start RUN-NORTHSTAR.bat: ${launcherError.message}`)
    if (child.exitCode !== null) throw new Error(`RUN-NORTHSTAR.bat exited with code ${child.exitCode} before the GUI opened. Launcher output:\n${launcherOutput.slice(-12000)}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('Timed out waiting for the GUI launched by RUN-NORTHSTAR.bat')
}

async function main() {
  let child
  let socket
  let requestId = 0
  let dialogs = 0
  const pending = new Map()
  try {
    assert.ok(fs.existsSync(launcher), `Root launcher is missing: ${launcher}`)
    legacyPackageState = seedLegacyPackageSentinel()
    assert.ok(fs.existsSync(packagedExecutable), 'A stale packaged executable must coexist with the source-build launch')
    const port = await freePort()
    // /S /C strips the outer quotes and leaves the quoted batch path intact.
    // Verbatim argv is required because Node otherwise escapes those quotes for cmd.exe.
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
      cwd: repoRoot, windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, NORTHSTAR_M9_BATCH_SMOKE: '1', NORTHSTAR_M9_CDP_PORT: String(port), NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_OPEN_FILE: fixturePath }
    })
    child.on('error', (error) => { launcherError = error })
    child.stdout.setEncoding('utf8').on('data', collectLauncherOutput)
    child.stderr.setEncoding('utf8').on('data', collectLauncherOutput)
    const target = await waitForRenderer(child, port)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
        }
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        dialogs++
        socket.send(JSON.stringify({ id: ++requestId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
      }
    })
    await once(socket, 'open')
    const cdp = (method, params = {}) => {
      const id = ++requestId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
    const evaluate = async (expression) => {
      const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result?.value
    }
    const waitFor = async (expression, description) => {
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        if (launcherError) throw new Error(`Could not start RUN-NORTHSTAR.bat: ${launcherError.message}`)
        if (child.exitCode !== null) throw new Error(`RUN-NORTHSTAR.bat exited with code ${child.exitCode} while waiting for ${description}. Launcher output:\n${launcherOutput.slice(-12000)}`)
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    await cdp('Runtime.enable')
    await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'current source editor UI')
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('M9 현재 소스 확인')", 'smoke document loaded by current source')
    await evaluate(`(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.includes('내보내기')); if (!button) throw new Error('Export menu button is missing'); button.click(); return true })()`)
    await waitFor("Array.from(document.querySelectorAll('[role=menuitem]')).some((item) => item.innerText.includes('Illustrator AI'))", 'Illustrator AI export menu item')
    const clicked = await evaluate(`(() => { const item = Array.from(document.querySelectorAll('[role=menuitem]')).find((entry) => entry.innerText.includes('Illustrator AI')); if (!item || item.disabled) return false; item.click(); return true })()`)
    assert.equal(clicked, true, 'Illustrator AI export item was not clickable')
    const untilDialog = Date.now() + 10_000
    while (dialogs === 0 && Date.now() < untilDialog) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(dialogs > 0, 'Clicking Illustrator AI did not invoke its confirmation dialog')
    assert.ok(sourceBuildMarkers.has('Building PSD Bridge...'), 'Root launcher did not build the PSD Bridge from source')
    assert.ok(sourceBuildMarkers.has('Building Northstar Editor...'), 'Root launcher did not build the current editor source')
    assert.ok(sourceBuildMarkers.has('Starting Northstar Editor...'), 'Root launcher did not start the source-built editor')
    console.log(`[m9-batch-gui-smoke] PASS (${legacyPackageState} package present): root launcher built current source, opened GUI, and exposed/clicked Illustrator AI`)
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    }
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true })
    cleanupLegacyPackageSentinel()
    assert.equal(fs.existsSync(tempRoot), false, 'M9 temporary smoke files were not removed')
    if (seededLegacyExecutable) assert.equal(fs.existsSync(packagedExecutable), false, 'M9 stale-package sentinel was not removed')
  }
}

main().catch((error) => {
  console.error(`[m9-batch-gui-smoke] FAILED: ${error.stack || error}`)
  process.exitCode = 1
})
