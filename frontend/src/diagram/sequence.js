/*
 * A Mermaid `sequenceDiagram`, rewritten as the flowchart this importer already understands.
 *
 * A sequence diagram and an architecture diagram share what an import needs: who the parties are and
 * who talks to whom. So rather than a second parser and a second layout, each participant becomes a
 * node and each message a labelled link, in the order the messages are written -- and the rest of the
 * import (kinds, zones, layout, edges) is the flowchart path unchanged.
 *
 * What does not survive is time: a flowchart has no vertical axis to order messages on, so the order
 * is kept in the link order and, when the diagram says `autonumber`, in the labels ("1. ...").
 * Notes, activation bars and the blocks around messages (loop, alt, opt, par, ...) have no flowchart
 * equivalent; they are dropped and reported, so a diagram with one still imports.
 */

/* Longest first, so `-->>` is not read as `-->` followed by `>`. `dashed` is the double dash. */
const ARROWS = [
  ['<<-->>', { dashed: true, both: true }],
  ['<<->>', { dashed: false, both: true }],
  ['-->>', { dashed: true }],
  ['->>', { dashed: false }],
  ['-->', { dashed: true }],
  ['->', { dashed: false }],
  ['--x', { dashed: true }],
  ['-x', { dashed: false }],
  ['--)', { dashed: true }],
  ['-)', { dashed: false }],
]

const BLOCK = /^(loop|alt|else|opt|par|and|critical|option|break|rect|end|box)\b/i
const IGNORED = /^(activate|deactivate|link|links|create|destroy)\b/i

export function isSequenceDiagram(text) {
  return /^\s*sequenceDiagram\b/i.test(text)
}

const safeId = (name) => name.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || 'participant'
const quote = (text) => `"${text.replace(/"/g, '#quot;').replace(/\|/g, '#124;')}"`

/**
 * @param body  the diagram text, without any code fence, starting at `sequenceDiagram`
 * @returns {{text: string, title: string | null, warnings: string[]}} flowchart text for `parseMermaid`
 */
export function sequenceToFlowchart(body) {
  const participants = new Map() // id -> {label, actor}
  const messages = []
  let title = null
  let numbered = false
  let notes = 0
  let blocks = 0

  const declare = (name, label, actor = false) => {
    const id = safeId(name)
    const known = participants.get(id)
    if (!known) participants.set(id, { label: label ?? name, actor })
    else if (label) participants.set(id, { label, actor: known.actor || actor })
    return id
  }

  for (const raw of body.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue

    let match = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line)
    if (match) {
      declare(match[2].trim(), match[3]?.trim(), match[1].toLowerCase() === 'actor')
      continue
    }
    if ((match = /^title\s*:?\s*(.+)$/i.exec(line))) {
      title = match[1].trim()
      continue
    }
    if (/^autonumber\b/i.test(line)) {
      numbered = true
      continue
    }
    if (/^note\b/i.test(line)) {
      notes++
      continue
    }
    if (BLOCK.test(line)) {
      if (!/^(end|else|and|option)\b/i.test(line)) blocks++
      continue
    }
    if (IGNORED.test(line)) continue

    const message = /^(.+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([^:\s]+)\s*(?::\s*(.*))?$/.exec(line)
    if (message) {
      const arrow = ARROWS.find(([symbol]) => symbol === message[2])[1]
      const from = declare(message[1].trim())
      const to = declare(message[4])
      messages.push({ from, to, text: (message[5] ?? '').trim(), ...arrow })
    }
  }

  const lines = ['flowchart LR']
  for (const [id, { label, actor }] of participants) {
    lines.push(`  ${id}${actor ? '(' : '['}${quote(label)}${actor ? ')' : ']'}`)
  }
  messages.forEach((entry, index) => {
    const text = [numbered ? `${index + 1}.` : '', entry.text].filter(Boolean).join(' ')
    const link = `${entry.both ? '<' : ''}${entry.dashed ? '-.-' : '---'}>`
    lines.push(`  ${entry.from} ${link}${text ? `|${quote(text)}|` : ''} ${entry.to}`)
  })

  const warnings = []
  if (notes) warnings.push(`${notes} sequence-diagram note${notes === 1 ? '' : 's'} skipped — a flowchart has no place for them.`)
  if (blocks) warnings.push(`${blocks} loop/alt/opt block${blocks === 1 ? '' : 's'} flattened — their messages are kept, the grouping is not.`)
  return { text: lines.join('\n'), title, warnings }
}
