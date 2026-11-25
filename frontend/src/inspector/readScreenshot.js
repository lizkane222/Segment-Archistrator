/*
 * Reading text out of a picture, in the browser.
 *
 * Done here rather than on the server on purpose: a screenshot of a customer's identity settings is
 * theirs, and nothing about reading it needs it to leave the machine. The engine is Tesseract (WebAssembly),
 * loaded only when someone actually imports one -- it is several megabytes -- and served from this app's
 * own `/ocr/` folder (frontend/public/ocr) rather than a CDN, because the page's Content-Security-Policy
 * allows connections to itself and nowhere else. See the README beside those files.
 *
 * ## Why the picture is enlarged first
 *
 * A settings page is 9-10px text. Tesseract reads at around 30px a line: at the screenshot's own size it
 * turned `rcs_identity_id` into `res_identity_id` and dropped most underscores; at three times the size
 * it read every identifier in the sample table. So the image is drawn onto a canvas about 2400px wide first.
 */

const TARGET_WIDTH = 2400
const MAX_SCALE = 4

/** The picture as a canvas big enough to read, plus the original as a URL for showing back. */
export async function enlarge(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / bitmap.width))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d')
  /* White underneath, so a screenshot with a transparent edge is not read as black. */
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  return canvas
}

/**
 * @param file        an image `File` or `Blob`
 * @param onProgress  `(fraction, status)` while the engine loads and reads
 * @returns `{words}` -- `{text, x0, y0, x1, y1, confidence}` in the enlarged image's pixels
 */
export async function readWords(file, onProgress) {
  const canvas = await enlarge(file)
  const { createWorker } = await import('tesseract.js')
  const base = `${import.meta.env.BASE_URL}ocr`
  const worker = await createWorker('eng', 1, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/tesseract-core-lstm.wasm.js`,
    langPath: base,
    gzip: true,
    logger: (message) => onProgress?.(message.progress ?? 0, message.status ?? ''),
  })
  try {
    /* A block of text, spaces kept: the table is a grid, not a page of paragraphs. */
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })
    const { data } = await worker.recognize(canvas, {}, { blocks: true })
    const words = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
    )
    return {
      words: words.map((word) => ({
        text: word.text,
        x0: word.bbox.x0,
        y0: word.bbox.y0,
        x1: word.bbox.x1,
        y1: word.bbox.y1,
        confidence: word.confidence,
      })),
    }
  } finally {
    await worker.terminate()
  }
}
