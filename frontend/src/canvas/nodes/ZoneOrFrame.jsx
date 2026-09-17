/*
 * One React Flow node type, two things drawn.
 *
 * A divider is *a region the user drew*, which is what a custom zone already is -- so it is stored as
 * a zone and differs only in how it draws. That is not a shortcut, it is the whole reason dividers
 * cost so little: containment, reparenting on drag, growth, serialization, the zone round-trip and
 * the server's exemption from placement advice (`_custom_zones`) all already work for a zone, and a
 * second node *type* would have meant auditing every `type === 'zone'` test in the codebase --
 * layout, selection, rules, serialization, the resize branch in Canvas -- and getting a frame
 * excluded from exactly the ones that matter.
 *
 * So the split is here, at the last possible moment, and it is one expression. A dispatcher with no
 * hooks of its own, deliberately: a conditional return inside `ZoneNode` would sit in front of its
 * hooks, which is only safe as long as nothing ever turns a zone into a frame -- true today and
 * exactly the kind of assumption that stops being true quietly.
 */

import FrameNode from './FrameNode.jsx'
import ZoneNode from './ZoneNode.jsx'

export default function ZoneOrFrame(props) {
  return props.data?.frame ? <FrameNode {...props} /> : <ZoneNode {...props} />
}
