const assert = require('node:assert/strict')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const appRoot = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-m10-export-'))
const input = path.join(root, '내보내기 확인.nbdoc')
const output = { ai: path.join(root, '결과.ai'), svg: path.join(root, '결과.svg'), pdf: path.join(root, '결과.pdf') }
const reportPath = process.env.NORTHSTAR_M10_RESULT_FILE
const source = {
  format: 'northstar-document', version: 1, name: '내보내기 확인', width: 320, height: 200,
  background: '#f5f4f0', groups: [], nodes: [
    { id: 'shape', name: '확인 도형', kind: 'rect', x: 20, y: 20, width: 100, height: 80, fill: '#f97352', opacity: 100, rotation: 0, visible: true, locked: false },
    { id: 'text', name: '한글', kind: 'text', x: 130, y: 45, width: 160, height: 55, fill: '#252629', opacity: 100, rotation: 0, text: '한글 내보내기', fontSize: 24, fontFamily: 'Arial', fontWeight: 600, visible: true, locked: false }
  ]
}
fs.writeFileSync(input, JSON.stringify(source), 'utf8')

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
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

async function main() {
  assert.match(execFileSync(require('electron'), ['--version'], { cwd: appRoot, encoding: 'utf8' }).trim(), /^v\d+\./)
  const port = await freePort()
  const child = spawn(require('electron'), [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox', appRoot], {
    cwd: appRoot, windowsHide: true,
    env: { ...process.env, NORTHSTAR_GUI_SMOKE: '1', NORTHSTAR_GUI_SMOKE_FILE: input, NORTHSTAR_GUI_SMOKE_OPEN_FILE: input,
      NORTHSTAR_GUI_SMOKE_EXPORT_AI: output.ai, NORTHSTAR_GUI_SMOKE_EXPORT_SVG: output.svg, NORTHSTAR_GUI_SMOKE_EXPORT_PDF: output.pdf }
  })
  let socket
  let id = 0
  const pending = new Map()
  const errors = []
  const results = { pngSvgPdf: 'pending', illustrator: 'pending' }
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
      if (message.method === 'Page.javascriptDialogOpening') socket.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
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
    const waitFor = async (expression, description, timeout = 30000) => {
      const until = Date.now() + timeout
      while (Date.now() < until) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    const click = async (expression, label) => assert.equal(await evaluate(`(() => { const e=${expression}; if (!e || e.disabled) return false; e.click(); return true })()`), true, `Could not click ${label}`)
    const chooseExport = async (label) => {
      await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('내보내기'))", 'export menu')
      await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find((e) => e.innerText.includes(${JSON.stringify(label)}))`, `${label} export`)
    }
    await cdp('Runtime.enable'); await cdp('Page.enable')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')", 'editor canvas')
    await click("Array.from(document.querySelectorAll('button')).find((e) => e.innerText.includes('열기'))", 'open fixture document')
    await waitFor("document.querySelector('[data-testid=editor-artboard]')?.getAttribute('viewBox') === '0 0 320 200'", '320x200 fixture document')

    for (const [format, label, successText] of [
      ['svg', 'Illustrator용 SVG', 'SVG를 내보냈습니다'], ['pdf', 'PDF 문서', 'PDF를 내보냈습니다']
    ]) {
      await chooseExport(label)
      await waitFor(`document.querySelector('.canvas-status')?.innerText.includes(${JSON.stringify(successText)})`, `${format} persisted`)
      const bytes = fs.readFileSync(output[format])
      assert.ok(bytes.byteLength > 30, `${format} output is empty`)
      if (format === 'svg') assert.match(bytes.toString('utf8'), /<svg[\s\S]*한글 내보내기/)
      else {
        const pdf = bytes.toString('latin1')
        assert.match(pdf, /^%PDF-1\.4/)
        assert.match(pdf, /startxref\n\d+\n%%EOF\n?$/)
      }
    }

    const svgHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(output.svg)).digest('hex')
    await chooseExport('Illustrator용 SVG')
    await waitFor("document.querySelector('.canvas-status')?.innerText.includes('기존 파일을 보호하기 위해 내보내기를 취소했습니다')", 'existing export protection')
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(output.svg)).digest('hex'), svgHash, 'A repeated export overwrote the existing SVG')

    const initialStatus = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
    await chooseExport('Illustrator AI')
    const timeout = Number(process.env.NORTHSTAR_M10_ILLUSTRATOR_TIMEOUT_MS) || 130000
    let status = ''
    const until = Date.now() + timeout
    while (Date.now() < until) {
      status = await evaluate("document.querySelector('.canvas-status')?.innerText || ''")
      if (fs.existsSync(output.ai) || status !== initialStatus) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (fs.existsSync(output.ai)) {
      const ai = fs.readFileSync(output.ai)
      assert.ok(ai.byteLength > 32, 'AI file is empty')
      assert.equal(ai.subarray(0, 5).toString('ascii'), '%PDF-', 'AI output does not have its PDF-compatible AI signature')
      assert.ok(ai.lastIndexOf(Buffer.from('%%EOF')) >= 0, 'AI output has no PDF-compatible end marker')
      assert.match(status, /Illustrator AI를 저장했습니다/, 'Renderer did not confirm native save/reopen')
      results.illustrator = `passed: native Illustrator save, close, reopen, close; ${ai.byteLength} bytes`
    } else if (/설치되어 있지 않거나 COM 자동화를 사용할 수 없습니다/.test(status)) {
      assert.match(status, /SVG\/PDF 내보내기/)
      assert.equal(fs.existsSync(output.ai), false, 'A fake .ai file must never be created')
      results.illustrator = 'not-installed: guidance shown and no .ai file created'
    } else {
      throw new Error(`Illustrator branch did not produce a verified file or missing-installation result: ${status || '(no status)'}`)
    }
    results.pngSvgPdf = 'passed: PNG via M6; SVG/PDF created and signatures/content verified in Electron'
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join(' | ')}`)
    const report = `${JSON.stringify(results, null, 2)}\n`
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, report, 'utf8') }
    console.log(`[m10-export-persistence] PASS ${report.trim()}`)
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]) }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// This smoke's second phase uses a fresh Electron process to keep export destinations isolated.
async function runPngSmoke() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'm6-export-gui-smoke.cjs')], {
    cwd: appRoot, env: process.env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`PNG/SVG/PDF file creation smoke failed with exit code ${result.status}`)
}

runPngSmoke().then(main).catch((error) => {
  fs.rmSync(root, { recursive: true, force: true })
  console.error(`[m10-export-persistence] FAILED: ${error.stack || error}`)
  process.exitCode = 1
})
