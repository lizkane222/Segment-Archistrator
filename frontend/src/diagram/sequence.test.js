import { describe, expect, it } from 'vitest'

import { looksLikeMermaid, mermaidToGraph } from './mermaid.js'
import { sequenceToFlowchart } from './sequence.js'

const DOC = `# Visual Specs

\`\`\`
+------+
| ASCII |
+------+
\`\`\`

\`\`\`mermaid
sequenceDiagram
    autonumber
    actor Developer
    participant Agent as Agent / IDE Host
    participant MCP as Twilio MCP Server
    Developer->>Agent: Prompt: "Build SMS verification"
    Note over Agent: Skill instructs: use Verify
    Agent->>MCP: Call twilio__search("x")
    MCP-->>Agent: Search results with IDs
    Agent->>Developer: Outputs code
\`\`\`
`

describe('sequence diagrams', () => {
  it('is recognised as Mermaid, including inside a Markdown file', () => {
    expect(looksLikeMermaid(DOC)).toBe(true)
    expect(looksLikeMermaid('sequenceDiagram\n A->>B: hi')).toBe(true)
  })

  it('imports participants as custom components and messages as labelled, ordered connectors', () => {
    const { graph, warnings } = mermaidToGraph(DOC)
    expect(graph.nodes.map((n) => n.name)).toEqual(['Developer', 'Agent / IDE Host', 'Twilio MCP Server'])
    expect(graph.nodes.every((n) => n.kind === 'custom')).toBe(true)
    expect(graph.edges).toHaveLength(4)
    expect(graph.edges[0].label).toBe('1. Prompt: "Build SMS verification"')
    expect(graph.edges[2].strokeStyle).toBe('dashed')
    expect(warnings.join(' ')).toMatch(/1 sequence-diagram note skipped/)
  })

  it('reads every arrow form and keeps implicit participants', () => {
    const { text } = sequenceToFlowchart('sequenceDiagram\nA-)B: async\nB--xA: lost\nA->>+B: go')
    expect(text).toContain('A ---> B'.replace('--->', '--->|' + '"async"|'))
    expect(text.match(/\|/g).length).toBe(6)
  })
})
