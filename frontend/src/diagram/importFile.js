/*
 * Which dropped files the importer can read.
 *
 * The extension is only a first filter, to say "that is not a diagram file" before reading a PNG into
 * memory. What a file actually *is* -- Segment export, Lucid export, Mermaid -- is decided from its
 * content by the importer, so a flowchart saved as `.txt` and a renamed JSON export both still work.
 */

export const IMPORT_EXTENSIONS = ['.json', '.mmd', '.mermaid', '.md', '.txt']

export const IMPORT_ACCEPT = ['application/json', ...IMPORT_EXTENSIONS].join(',')

export const ACCEPTED_LABEL = 'JSON (Archistrator or Lucid export) and Mermaid (.mmd, .mermaid, .md, .txt)'

export function isImportable(file) {
  const name = String(file?.name ?? '').toLowerCase()
  return IMPORT_EXTENSIONS.some((ext) => name.endsWith(ext)) || file?.type === 'application/json'
}

/** Whether a drag carries files from outside the page (not one of the dialog's own entries). */
export function dragHasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}
