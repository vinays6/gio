/* eslint-disable @typescript-eslint/no-explicit-any */
;(self as any).onmessage = async (e: MessageEvent<{ bitmap: ImageBitmap; width: number; height: number }>) => {
  const { bitmap, width, height } = e.data
  try {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const CHUNK = 8192
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK)
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    self.postMessage({ dataUrl: `data:image/jpeg;base64,${btoa(binary)}` })
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
