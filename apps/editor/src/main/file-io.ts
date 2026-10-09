import { open } from 'node:fs/promises'

export async function readFileWithinLimit(filePath: string, maxBytes: number, format: string): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${format} 입력은 일반 파일이어야 합니다.`)
    if (!Number.isSafeInteger(metadata.size) || metadata.size > maxBytes) {
      throw new Error(`${format} 파일이 ${Math.floor(maxBytes / (1024 * 1024))} MiB 입력 제한을 초과합니다.`)
    }
    const expectedBytes = metadata.size
    const bytes = Buffer.allocUnsafe(expectedBytes)
    let offset = 0
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(bytes, offset, expectedBytes - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}
