import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileWithinLimit } from '../src/main/file-io.ts'

test('reads a bounded file and rejects an oversized file before allocating its contents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northstar-bounded-file-'))
  const filePath = path.join(root, 'input.psd')
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53])
  try {
    await writeFile(filePath, bytes)
    assert.deepEqual(await readFileWithinLimit(filePath, bytes.length, 'PSD'), bytes)
    await assert.rejects(readFileWithinLimit(filePath, bytes.length - 1, 'PSD'), /PSD.*입력 제한을 초과/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
