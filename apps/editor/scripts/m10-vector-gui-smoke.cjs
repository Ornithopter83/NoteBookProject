const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const appRoot = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m10-vector-'))
const sourcePath = path.join(temp, '한글 벡터 확인.nbdoc')
const svgPath = path.join(temp, '한글 벡터 결과.svg')
// Small real PNG/JPEG images keep the smoke quick while exercising both decoders.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQImWNgYGD4z8DAwMDAxAADAAUAAf+X0h8AAAAASUVORK5CYII='
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k='
const originals = { png: Buffer.from(png, 'base64'), jpeg: Buffer.from(jpeg, 'base64') }
const formatExportSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
const document = { format: 'northstar-document', version: 1, name: '한글 벡터 확인 \u0001/I12 N=123', width: 1440, height: 960, background: '#f5f4f0', groups: [], nodes: [
  { id: 'image-png', name: '색상 PNG', kind: 'image', x: 100, y: 100, width: 400, height: 400, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/png;base64,${png}`, visible: true, locked: false },
  { id: 'image-jpeg', name: '색상 JPEG', kind: 'image', x: 600, y: 100, width: 400, height: 400, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/jpeg;base64,${jpeg}`, visible: true, locked: false }
] }
try { fs.writeFileSync(sourcePath, JSON.stringify(document), 'utf8') }
catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error }

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
async function main() {
  assert.match(execFileSync(require('electron'), ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const port = await freePort()
  const child = spawn(require('electron'), [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: sourcePath, NORTHSTAR_GUI_SMOKE_OPEN_FILE: sourcePath, NORTHSTAR_GUI_SMOKE_EXPORT_SVG: svgPath }
  })
  let socket; let id = 0
  const pending = new Map()
  try {
    let target
    const until = Date.now() + 30000
    while (!target && Date.now() < until) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl) } catch {}
      if (!target) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (!target) throw new Error('Timed out waiting for editor window')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) { const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) } }
      if (message.method === 'Page.javascriptDialogOpening') socket.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
    })
    await once(socket, 'open')
    const cdp = (method, params = {}) => { const requestId = ++id; return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) }) }
    const evaluate = async (expression) => { const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
    const waitFor = async (expression, label) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 150)) } throw new Error(`Timed out waiting for ${label}`) }
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'editor canvas')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open fixture')
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('한글 벡터 확인') && document.querySelector('[data-node-id=image-png] image') && document.querySelector('[data-node-id=image-jpeg] image')", 'Korean document and PNG/JPEG images')
    const cleanTitle = await evaluate("document.querySelector('.document-tab')?.innerText || ''")
    assert.match(cleanTitle, /한글 벡터 확인/, 'Korean document name was not retained')
    assert.doesNotMatch(cleanTitle, /\/I\d+\s+N\s*=|SourceId|%PDF-|\ufffd/, 'Damaged metadata leaked into the document title')

    for (const [id, label, imageMime] of [['image-png', '색상 PNG', 'png'], ['image-jpeg', '색상 JPEG', 'jpeg']]) {
      await click(`Array.from(document.querySelectorAll('.layer-row')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `select ${label}`)
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('이미지 벡터화'))", `vectorize ${label}`)
      await waitFor("document.querySelector('[role=dialog][aria-labelledby=vector-preview-title] svg path')", `${label} preview paths`)
      const previewPaths = await evaluate("document.querySelectorAll('[aria-labelledby=vector-preview-title] svg path').length")
      assert.ok(previewPaths > 0, `${label} preview had no SVG paths`)
      await click("Array.from(document.querySelectorAll('[role=dialog] button')).find((e) => e.innerText.includes('경로 적용'))", `apply ${label} vectors`)
      await waitFor(`document.querySelector('[data-node-id=${id}] [data-testid=vectorized-image] path')`, `${label} applied paths`)
      assert.equal((await evaluate(`document.querySelector('[data-node-id=${id}] image') === null`)), true, `${label} source should display as vectors after apply`)
      assert.ok(originals[imageMime].byteLength > 0)
    }

    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('.nbdoc 저장'))", 'save vectorized document')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('모든 변경 사항이 저장되었습니다')", 'vectorized document save')
    const saved = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
    let expectedPaths = 0
    for (const [id, imageMime] of [['image-png', 'png'], ['image-jpeg', 'jpeg']]) {
      const savedImage = saved.nodes.find((node) => node.id === id)
      assert.ok(savedImage?.vectorData?.paths.length > 0, `${id} paths were not saved`)
      assert.equal(typeof savedImage.resourcePath, 'string', `${id} original image resource was not preserved`)
      const resource = fs.readFileSync(path.join(temp, savedImage.resourcePath))
      assert.deepEqual(resource, originals[imageMime], `${id} original image bytes changed`)
      assert.equal(savedImage.vectorData.sourceWidth, imageMime === 'png' ? 2 : 1)
      assert.equal(savedImage.vectorData.sourceHeight, imageMime === 'png' ? 2 : 1, `${id} source height was not retained`)
      expectedPaths += savedImage.vectorData.paths.length
    }
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'reopen saved document')
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('한글 벡터 확인') && document.querySelectorAll('[data-testid=vectorized-image] path').length > 0", 'reopened vectorized document')
    for (const id of ['image-png', 'image-jpeg']) {
      const savedPaths = saved.nodes.find((node) => node.id === id).vectorData.paths.map((path) => path.d)
      const reopenedPaths = await evaluate(`Array.from(document.querySelectorAll('[data-node-id=${id}] [data-testid=vectorized-image] path')).map((path) => path.getAttribute('d'))`)
      assert.deepEqual(reopenedPaths, savedPaths, `${id} vector path data changed or crossed layers on reopen`)
    }

    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
    await click("Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes('Illustrator용 SVG'))", 'SVG export')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('SVG를 내보냈습니다')", 'SVG saved with actual size')
    const svg = fs.readFileSync(svgPath, 'utf8')
    const actualSize = fs.statSync(svgPath).size
    assert.ok(actualSize > 0, 'SVG output file is empty')
    assert.match(svg, /<svg[^>]*viewBox/)
    assert.match(svg, /<path\b[^>]*d="M/)
    assert.equal((svg.match(/<path\b/g) || []).length, expectedPaths, 'SVG path count does not match both saved vector layers')
    assert.doesNotMatch(svg, /<image\b/, 'SVG export unexpectedly used raster image elements')
    const status = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
    assert.ok(status.includes(formatExportSize(actualSize)), 'UI-reported SVG byte size did not match the file on disk')
    console.log(`Vector GUI smoke passed: Korean metadata filtering; PNG/JPEG vector paths; preserved source bytes; save/reopen; ${actualSize}-byte SVG with ${expectedPaths} paths.`)
  } finally {
    socket?.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch((error) => { fs.rmSync(temp, { recursive: true, force: true }); console.error(error); process.exitCode = 1 })
