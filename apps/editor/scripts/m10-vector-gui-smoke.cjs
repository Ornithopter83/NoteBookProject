const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const appRoot = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m10-vector-'))
const sourcePath = path.join(temp, '벡터 원본.nbdoc')
const svgPath = path.join(temp, '벡터 결과.svg')
// 2x2 PNG with distinct opaque colors, sufficient to produce four closed path contours.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQImWNgYGD4z8DAwMDAxAADAAUAAf+X0h8AAAAASUVORK5CYII='
const document = { format: 'northstar-document', version: 1, name: '한글 벡터 원본', width: 1440, height: 960, background: '#f5f4f0', groups: [], nodes: [
  { id: 'image-1', name: '색상 PNG', kind: 'image', x: 100, y: 100, width: 400, height: 400, fill: '#fff', opacity: 100, rotation: 0, src: `data:image/png;base64,${png}`, visible: true, locked: false }
] }
fs.writeFileSync(sourcePath, JSON.stringify(document), 'utf8')

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
    await waitFor("document.querySelector('.document-tab')?.innerText.includes('한글 벡터 원본') && document.querySelector('[data-node-id=image-1] image')", 'Korean document and image')
    await click("Array.from(document.querySelectorAll('.layer-row')).find((e) => e.innerText.includes('색상 PNG'))", 'select image')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('이미지 벡터화'))", 'vectorize image')
    await waitFor("document.querySelector('[role=dialog][aria-labelledby=vector-preview-title] svg path')", 'vector preview paths')
    const previewPaths = await evaluate("document.querySelectorAll('[aria-labelledby=vector-preview-title] svg path').length")
    assert.ok(previewPaths > 0, 'Vector preview did not contain SVG paths')
    await click("Array.from(document.querySelectorAll('[role=dialog] button')).find((e) => e.innerText.includes('경로 적용'))", 'apply vector paths')
    await waitFor("document.querySelector('[data-testid=vectorized-image] path') && document.querySelector('[data-node-id=image-1]')?.querySelector('[data-testid=vectorized-image]')", 'applied vectors with source layer retained')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('.nbdoc 저장'))", 'save vectorized document')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('모든 변경 사항이 저장되었습니다')", 'vectorized document save')
    const saved = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
    const savedImage = saved.nodes.find((node) => node.id === 'image-1')
    assert.equal(savedImage.vectorData.sourceWidth, 2, 'Saved vector source width is incorrect')
    assert.equal(savedImage.vectorData.sourceHeight, 2, 'Saved vector source height is incorrect')
    assert.ok(savedImage.vectorData.paths.length > 0, 'Saved document has no vector paths')
    assert.equal(typeof savedImage.resourcePath, 'string', 'Original image resource was not preserved')
    assert.ok(fs.existsSync(path.join(temp, savedImage.resourcePath)), 'Original image resource file is missing')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
    await click("Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes('Illustrator용 SVG'))", 'SVG export')
    const deadline = Date.now() + 20000
    while (!fs.existsSync(svgPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(fs.existsSync(svgPath), 'SVG export was not created')
    const svg = fs.readFileSync(svgPath, 'utf8')
    assert.match(svg, /<path\b[^>]*d="M/)
    assert.match(svg, /<svg[^>]*viewBox/)
    console.log('Vector GUI smoke passed: Korean title, before/after paths, preserved source node, and SVG path export.')
  } finally {
    socket?.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch((error) => { fs.rmSync(temp, { recursive: true, force: true }); console.error(error); process.exitCode = 1 })
