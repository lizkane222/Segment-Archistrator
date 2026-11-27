/*
 * A URL that is safe to put in an `href` or an `src`, or null.
 *
 * Link targets on a component (`docsUrl`, `workspaceUrl`, `previewWebhookUrl`, `logoUrl`) live in
 * the saved diagram, and a diagram can be shared with a workspace or opened from a file. A
 * `javascript:` or `data:` URL there is script that runs as this page when somebody clicks it,
 * so only absolute http(s) URLs pass. The server drops the same values on save
 * (`sanitize_graph`); this is the other half, because a graph reaches the canvas from a file
 * and from older rows without passing through that.
 */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}
