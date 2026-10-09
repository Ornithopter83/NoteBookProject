const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const repoRoot = path.resolve(__dirname, '../../..')
const launcher = path.join(repoRoot, 'RUN-NORTHSTAR.bat')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m10-batch-flow-'))
const documentPath = path.join(temp, '한글 Northstar 벡터 확인.nbdoc')
const svgPath = path.join(temp, '한글 Northstar 벡터 확인.svg')
const aiSvgPath = path.join(temp, 'Illustrator 대체 내보내기.svg')
const aiPath = path.join(temp, '한글 Northstar 벡터 확인.ai')
const reportPath = process.env.NORTHSTAR_M10_BATCH_RESULT_FILE
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQImWNgYGD4z8DAwMDAxAADAAUAAf+X0h8AAAAASUVORK5CYII='
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k='
const originalBytes = { png: Buffer.from(png, 'base64'), jpeg: Buffer.from(jpeg, 'base64') }
const formatExportSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
const fixture = { format: 'northstar-document', version: 1, name: '한글 Northstar 문서 \u0001/I12 N=123', width: 960, height: 640, background: '#f5f4f0', groups: [], nodes: [
  { id: 'image-png', name: 'PNG 이미지', kind: 'image', x: 70, y: 70, width: 320, height: 320, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/png;base64,${png}`, visible: true, locked: false },
  { id: 'image-jpeg', name: 'JPEG 이미지', kind: 'image', x: 470, y: 70, width: 320, height: 320, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/jpeg;base64,${jpeg}`, visible: true, locked: false }
] }
try { fs.writeFileSync(documentPath, `${JSON.stringify(fixture)}\n`, 'utf8') }
catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error }

let launcherOutput = ''
let launcherError
const launcherMarkers = new Set()
function collectLauncherOutput(chunk) {
  const combined = launcherOutput + chunk
  for (const marker of ['Building PSD Bridge...', 'Building Northstar Editor...', 'Starting Northstar Editor...']) if (combined.includes(marker)) launcherMarkers.add(marker)
  launcherOutput = combined.slice(-16000)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
async function waitForTarget(child, port) {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    if (launcherError) throw launcherError
    if (child.exitCode !== null) throw new Error(`RUN-NORTHSTAR.bat exited with code ${child.exitCode} before GUI startup.\n${launcherOutput}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for RUN-NORTHSTAR.bat GUI.\n${launcherOutput}`)
}
async function stopLauncher(child) {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
}

async function main() {
  assert.equal(process.platform, 'win32', 'This E2E exercises the Windows RUN-NORTHSTAR.bat launcher')
  assert.ok(fs.existsSync(launcher), `Launcher not found: ${launcher}`)
  let child
  let socket
  let requestId = 0
  let dialogs = 0
  const pending = new Map()
  try {
    const port = await freePort()
    // Invoke the actual no-argument launcher; environment values only enable smoke control and CDP.
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
      cwd: repoRoot, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, NORTHSTAR_M9_BATCH_SMOKE: '1', NORTHSTAR_M9_CDP_PORT: String(port), NORTHSTAR_GUI_SMOKE: '1',
        NORTHSTAR_GUI_SMOKE_FILE: documentPath, NORTHSTAR_GUI_SMOKE_OPEN_FILE: documentPath,
        NORTHSTAR_GUI_SMOKE_EXPORT_SVG: svgPath, NORTHSTAR_GUI_SMOKE_EXPORT_AI: aiPath, NORTHSTAR_GUI_SMOKE_EXPORT_AI_SVG: aiSvgPath,
        NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_UNAVAILABLE: '1', NORTHSTAR_GUI_SMOKE_ILLUSTRATOR_FALLBACK: 'cancel,svg' }
    })
    child.on('error', (error) => { launcherError = error })
    child.stdout.setEncoding('utf8').on('data', collectLauncherOutput)
    child.stderr.setEncoding('utf8').on('data', collectLauncherOutput)
    const target = await waitForTarget(child, port)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const request = pending.get(message.id)
        if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) }
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        dialogs++
        socket.send(JSON.stringify({ id: ++requestId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
      }
    })
    await once(socket, 'open')
    const cdp = (method, params = {}) => { const id = ++requestId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }
    const evaluate = async (expression) => {
      const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result?.value
    }
    const waitFor = async (expression, description, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (launcherError) throw launcherError
        if (child.exitCode !== null) throw new Error(`RUN-NORTHSTAR.bat exited during ${description}: ${child.exitCode}\n${launcherOutput}`)
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    const waitForFile = async (filePath, description, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (launcherError) throw launcherError
        if (child.exitCode !== null) throw new Error(`RUN-NORTHSTAR.bat exited during ${description}: ${child.exitCode}\n${launcherOutput}`)
        if (fs.existsSync(filePath)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    const chooseExport = async (label) => {
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
      await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, label)
    }

    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'source-built editor window')
    assert.ok(launcherMarkers.has('Building PSD Bridge...'), 'Root launcher did not build the PSD Bridge')
    assert.ok(launcherMarkers.has('Building Northstar Editor...'), 'Root launcher did not build the editor')
    assert.ok(launcherMarkers.has('Starting Northstar Editor...'), 'Root launcher did not start the editor')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open Korean fixture')
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('한글 Northstar 문서') && document.querySelectorAll('[data-node] image').length === 2", 'Korean document with PNG and JPEG layers')
    const title = await evaluate("document.querySelector('.document-tab')?.innerText || ''")
    assert.match(title, /한글 Northstar 문서/)
    assert.doesNotMatch(title, /\/I\d+\s+N\s*=|SourceId|%PDF-|\ufffd/, 'Damaged metadata was displayed')

    for (const [id, label] of [['image-png', 'PNG 이미지'], ['image-jpeg', 'JPEG 이미지']]) {
      await click(`Array.from(document.querySelectorAll('.layer-row')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `select ${label}`)
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('이미지 벡터화'))", `vectorize ${label}`)
      await waitFor("document.querySelector('[role=dialog][aria-labelledby=vector-preview-title] svg path')", `${label} preview paths`)
      assert.ok(await evaluate("document.querySelectorAll('[aria-labelledby=vector-preview-title] svg path').length") > 0, `${label} preview has no path`)
      await click("Array.from(document.querySelectorAll('[role=dialog] button')).find((e) => e.innerText.includes('경로 적용'))", `apply ${label} vectors`)
      await waitFor(`document.querySelector('[data-node-id=${id}] [data-testid=vectorized-image] path')`, `${label} vector paths`)
      assert.equal(await evaluate(`document.querySelector('[data-node-id=${id}] image') === null`), true, `${label} no longer renders the original after vectorization`)
    }
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('.nbdoc 저장'))", 'save source document')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('모든 변경 사항이 저장되었습니다')", 'document save')
    const saved = JSON.parse(fs.readFileSync(documentPath, 'utf8'))
    let totalPaths = 0
    for (const [id, extension] of [['image-png', 'png'], ['image-jpeg', 'jpg']]) {
      const node = saved.nodes.find((item) => item.id === id)
      assert.ok(node.vectorData?.paths?.length, `${id} paths were not persisted`)
      totalPaths += node.vectorData.paths.length
      assert.ok(node.resourcePath, `${id} original file was not retained`)
      assert.deepEqual(fs.readFileSync(path.join(temp, node.resourcePath)), originalBytes[extension === 'png' ? 'png' : 'jpeg'], `${id} original bytes changed`)
      assert.match(node.resourcePath, new RegExp(`\\.${extension}$`))
      assert.equal(node.vectorData.sourceWidth, extension === 'png' ? 2 : 1, `${id} source width was not retained`)
      assert.equal(node.vectorData.sourceHeight, extension === 'png' ? 2 : 1, `${id} source height was not retained`)
    }
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'reopen saved .nbdoc')
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('한글 Northstar') && document.querySelectorAll('[data-testid=vectorized-image] path').length > 0", 'saved vector document reopened')
    for (const id of ['image-png', 'image-jpeg']) {
      const savedPaths = saved.nodes.find((item) => item.id === id).vectorData.paths.map((item) => item.d)
      const reopenedPaths = await evaluate(`Array.from(document.querySelectorAll('[data-node-id=${id}] [data-testid=vectorized-image] path')).map((item) => item.getAttribute('d'))`)
      assert.deepEqual(reopenedPaths, savedPaths, `${id} vector path data changed or crossed layers on reopen`)
    }

    await chooseExport('Illustrator용 SVG')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('SVG를 내보냈습니다')", 'SVG export')
    const svg = fs.readFileSync(svgPath, 'utf8')
    const svgBytes = fs.statSync(svgPath).size
    assert.ok(svgBytes > 0)
    assert.match(svg, /<svg[^>]*viewBox/)
    assert.equal((svg.match(/<path\b/g) || []).length, totalPaths, 'SVG output did not include paths from both image layers')
    assert.doesNotMatch(svg, /<image\b/, 'Vector export contains raster images')
    const svgStatus = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
    assert.ok(svgStatus.includes(formatExportSize(svgBytes)), 'SVG byte count reported in the UI differs from the real file')
    assert.equal(fs.readdirSync(temp).filter((name) => /\.tmp(?:\.ai)?$/.test(name)).length, 0, 'Export staging files were left behind')

    const priorStatus = svgStatus
    await chooseExport('Illustrator AI')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(fs.existsSync(aiPath), false, 'Canceling the SVG alternative created an AI file')
    assert.equal(fs.existsSync(aiSvgPath), false, 'Canceling the SVG alternative created a file')
    assert.equal(await evaluate("document.querySelector('.canvas-status')?.innerText || ''"), priorStatus, 'Canceling the SVG alternative changed the success status')
    await chooseExport('Illustrator AI')
    await waitForFile(aiSvgPath, 'SVG alternative file creation', 30000)
    await waitFor(`document.querySelector('.canvas-status')?.innerText.includes('SVG를 내보냈습니다') && document.querySelector('.canvas-status')?.innerText.includes(${JSON.stringify(path.basename(aiSvgPath))})`, 'SVG alternative success status for its own file', 30000)
    const aiStatus = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
    let illustrator
    if (fs.existsSync(aiSvgPath)) {
      const svgBytes = fs.readFileSync(aiSvgPath)
      const svg = svgBytes.toString('utf8')
      assert.ok(svgBytes.byteLength > 30, 'SVG alternative is empty')
      assert.match(svg, /<svg[^>]*viewBox/)
      assert.equal((svg.match(/<path\b/g) || []).length, totalPaths, 'SVG alternative did not include the vector paths')
      assert.match(aiStatus, /SVG를 내보냈습니다/)
      assert.doesNotMatch(aiStatus, /Illustrator AI를 저장했습니다/)
      assert.equal(fs.existsSync(aiPath), false, 'A fake .ai file was created for the SVG alternative')
      illustrator = `COM-unregistered: cancel created no file; SVG alternative verified (${svgBytes.byteLength} bytes); no .ai file created`
    } else if (fs.existsSync(aiPath)) {
      const aiBytes = fs.readFileSync(aiPath)
      assert.ok(aiBytes.byteLength > 32)
      assert.equal(aiBytes.subarray(0, 5).toString('ascii'), '%PDF-')
      assert.match(aiStatus, /Illustrator AI를 저장했습니다/, 'Installed Illustrator branch did not confirm save and reopen')
      illustrator = `installed: saved and reopened ${aiBytes.byteLength}-byte AI file`
    } else throw new Error(`AI export did not produce a verified AI or SVG file: ${aiStatus}`)
    assert.ok(dialogs > 0, 'Illustrator export did not show its confirmation dialog')
    assert.equal(fs.readdirSync(temp).filter((name) => /\.tmp(?:\.ai)?$/.test(name)).length, 0, 'Illustrator staging file was left behind')
    const report = { launcher: 'RUN-NORTHSTAR.bat with no arguments; source build and GUI launch verified', document: 'Korean title retained; damaged metadata filtered', images: 'PNG and JPEG vectorized; both originals preserved byte-for-byte', persistence: 'saved and reopened with vector paths', svg: `verified ${svgBytes} bytes and ${totalPaths} path elements`, illustrator }
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8') }
    console.log(`[m10-batch-user-flow] PASS ${JSON.stringify(report)}`)
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    await stopLauncher(child)
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch((error) => { fs.rmSync(temp, { recursive: true, force: true }); console.error(`[m10-batch-user-flow] FAILED: ${error.stack || error}`); process.exitCode = 1 })
