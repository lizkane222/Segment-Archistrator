/*
 * Export a diagram to a file, and rebuild one from a file exported this way.
 *
 * The stopgap for a diagram becoming unreachable through the workspace scope it was
 * drawn under -- an anonymous session's cookie lost after a restart, a token
 * reconnected under a different scope, see apps/auth_workspace. Nothing server-side
 * changes: this bundles exactly the document `serializeGraph` already produces for a
 * save, plus the name/description/sourceTemplate that live beside it in
 * `useDiagrams`, into one JSON file, and reads the same shape back.
 *
 * Validated on the way in because the file is untrusted input by the time it comes
 * back -- someone's browser downloads, someone's disk, maybe a week later. A stray
 * JSON file, or one from a future version this client does not understand, is one
 * wrong assumption away from reaching `applyGraph` and looking like a blank canvas
 * rather than a clear error.
 */

import { fileNameFor } from './exportImage.js'

export const DIAGRAM_FILE_FORMAT = 'segment-builder-diagram'
export const DIAGRAM_FILE_VERSION = 1

function asString(value) {
  return typeof value === 'string' ? value : ''
}

export function buildDiagramFile({ name, description, sourceTemplate, graph }) {
  return {
    format: DIAGRAM_FILE_FORMAT,
    version: DIAGRAM_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    name: asString(name),
    description: asString(description),
    sourceTemplate: asString(sourceTemplate),
    graph,
  }
}

/** The reverse of `buildDiagramFile`, with the validation an untrusted file needs. */
export function parseDiagramFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('That file is not a diagram export.')
  }
  if (parsed.format !== DIAGRAM_FILE_FORMAT) {
    throw new Error('That file is not a diagram exported from this app.')
  }
  if (typeof parsed.version !== 'number' || parsed.version > DIAGRAM_FILE_VERSION) {
    throw new Error('This diagram file was exported by a newer version of the app.')
  }

  const graph = parsed.graph
  if (
    !graph ||
    typeof graph !== 'object' ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error('That file is not a diagram export.')
  }

  return {
    name: asString(parsed.name),
    description: asString(parsed.description),
    sourceTemplate: asString(parsed.sourceTemplate),
    graph,
  }
}

/** Triggers a browser download of `doc`'s graph as a `.json` file. */
export function downloadDiagramFile({ name, description, sourceTemplate }, graph) {
  const file = buildDiagramFile({ name, description, sourceTemplate, graph })
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileNameFor(name, 'json')
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
