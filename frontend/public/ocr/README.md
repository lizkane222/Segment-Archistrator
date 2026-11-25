# OCR assets

Served to the browser for "Import from a screenshot" on identity resolution rules
(`src/inspector/readScreenshot.js`). They are here, and not loaded from a CDN, because the app's
Content-Security-Policy only allows connections to itself.

| File | From | Licence |
| --- | --- | --- |
| `worker.min.js` | `tesseract.js` (`dist/worker.min.js`) | Apache-2.0 |
| `tesseract-core-lstm.wasm.js` | `tesseract.js-core` | Apache-2.0 |
| `eng.traineddata.gz` | `@tesseract.js-data/eng` (`4.0.0_best_int`) | Apache-2.0 |

Keep the first two in step with the installed `tesseract.js` version when it is upgraded: the worker and
the core are a matched pair.
