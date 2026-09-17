/*
 * What can be done, in one table.
 *
 * The right-click menu and the keyboard are two views of the same list, and Stage 7's
 * build panel will be a third. Written as data rather than as handlers so they cannot
 * disagree: a command that is unavailable is unavailable in the menu *and* under its
 * shortcut, with one sentence explaining why, and there is no second place to update
 * when that changes.
 *
 * `enabled(ctx)` returns `true`, or **the reason it is not**. That return type is the
 * point of the whole module: the request asks the menu to say "what is possible on this
 * component", and a boolean cannot answer that -- a greyed "Duplicate" with no
 * explanation is the same dead end as no menu at all. So an unavailable command renders
 * greyed with its reason beside it, and the same string is what the toast says when the
 * shortcut is pressed instead.
 *
 * Pure. The commands reach the app only through `ctx.actions`, which is a plain object
 * of callbacks the caller supplies -- so the table, the enablement logic and the
 * shortcut matching are all testable with no canvas and no DOM.
 */

import { isGroupStackId } from '../canvas/grouping.js'

/**
 * The menus a command appears in.
 *
 * `null` means keyboard-only. Save and select-all are the two: both are in the header
 * or the canvas already, and a right-click menu that lists everything the app can do
 * is a menu nobody reads to the bottom of.
 */
export const NODE_MENU = 'node'
export const PANE_MENU = 'pane'
/* Right-clicking the line itself. A third menu rather than more rows on the node menu, because
   almost nothing that applies to a component applies to a connector -- and a menu whose top half
   is greyed out on every use is worse than two menus. */
export const EDGE_MENU = 'edge'

const both = [NODE_MENU, PANE_MENU]

/*
 * Nested items.
 *
 * A command with `children` is a submenu: it never runs itself, and its children are
 * ordinary commands in every other respect -- own `enabled`, own reason, own shortcut. The
 * parent's `enabled` gates the whole branch, which is what lets "Distribute" say *once*
 * that it needs three components rather than saying it twice inside a menu the user has to
 * open to read the refusal.
 *
 * Written as nesting in the table rather than as a `parent:` field on each child, because a
 * flat table with parent pointers has an ordering problem the nesting does not: the menu
 * would have to sort children back under their parents, and two commands could claim to be
 * each other's parent.
 */
const arrangeMove = (id, label, shortcut) => ({
  id,
  label,
  shortcut,
  enabled: (ctx) => selectionOf(ctx).length > 0 || 'Select something to restack.',
  run: (ctx) => ctx.actions.arrange(selectionOf(ctx), id.replace('arrange-', '')),
})

const alignTo = (id, label) => ({
  id: `align-${id}`,
  label,
  enabled: alignable,
  run: (ctx) => ctx.actions.align(alignTargets(ctx), id),
})

const distributeOn = (axis, label) => ({
  id: `distribute-${axis}`,
  label,
  enabled: distributable,
  run: (ctx) => ctx.actions.distribute(alignTargets(ctx), axis),
})

/*
 * One row of the Table submenu.
 *
 * The verb travels to the app rather than the operation being performed here, so this table stays
 * free of the table *model* -- `enabled` is given facts (how many rows there are) and `run` names
 * what to do, exactly as every other command here does. See `tableEdit` in AppShell.jsx for the
 * mapping onto canvas/tables.js.
 */
const tableEdit = (verb, label, enabled) => ({
  id: `table-${verb}`,
  label,
  enabled: enabled ?? (() => true),
  run: (ctx) => ctx.actions.tableEdit(ctx.node.id, verb, ctx.cell),
})

/* The `hint` is the tooltip. Three line styles is a choice about legibility rather than taste --
   right-angle reads as a pipeline, curved is followable where lines cross -- and a menu of three
   adjectives gives the user no way to know that. */
const lineStyle = (id, label, hint) => ({
  id: `line-${id}`,
  label,
  hint,
  enabled: (ctx) => Boolean(ctx.edge) || 'Right-click a connector to restyle it.',
  run: (ctx) => ctx.actions.lineStyle(ctx.edge.id, id),
})

/*
 * Which way data runs along a connector, said in the vocabulary of the drawing.
 *
 * The direction ids are canvas/direction.js's -- it owns what "down" means geometrically, and
 * a test pins these four against `FLOW_DIRECTIONS` so the two lists cannot drift. The labels
 * live here because they are menu copy: "Top to bottom" is how to *say* `down` to a reader,
 * and the geometry module has no business holding a phrase.
 *
 * `preview` is what makes this usable. Choosing a direction may turn a line round, and the
 * consequence of that is invisible in a menu -- so hovering a row animates the connector the
 * way it *would* run, on the canvas, before anything is committed. Resolved against the
 * context here so the menu only has to hand the value back.
 */
const flowOnEdge = (id, label, hint) => ({
  id: `flow-${id}`,
  label,
  hint,
  enabled: (ctx) =>
    !ctx.edge
      ? 'Right-click a connector to set which way it flows.'
      : (ctx.edge.data?.discovered ?? ctx.edge.discovered) === true
        ? 'This connection was read from the workspace, so its direction is a fact rather than a choice.'
        : true,
  preview: (ctx) => (ctx.edge ? { direction: id, edgeIds: [ctx.edge.id] } : null),
  run: (ctx) => ctx.actions.flowAlong([ctx.edge.id], id),
})

const flowOnAll = (id, label, hint) => ({
  id: `flow-all-${id}`,
  label,
  hint,
  enabled: (ctx) => ctx.edges?.length > 0 || 'There are no connectors on this diagram yet.',
  /* `edgeIds: null` means every connector, so the preview lights the whole diagram at once --
     which is the point of the bulk version: you can see how much of the diagram agrees with
     the direction you are about to assert before asserting it. */
  preview: () => ({ direction: id, edgeIds: null }),
  run: (ctx) => ctx.actions.flowAlong(null, id),
})

/*
 * "Put this on that path" -- one row per path the diagram has.
 *
 * ## Why the slots are numbered
 *
 * The rows have to be named after the user's own paths, and `runCommand` resolves an id against a
 * static table so the keyboard and the menu cannot disagree about what a command is. A row invented
 * per render would have an id that table has never heard of. So the ids are positional and the
 * *labels* are resolved from the context, which is the one thing that has to vary.
 *
 * Six, matching `PATH_COLORS`: past six paths the colours repeat and a menu stops being the right
 * way to choose anyway, so `add-to-path-more` points at the drawer instead of growing without limit.
 *
 * ## What the row actually does
 *
 * Not "append to a list". A path is walked from its start along the arrows, so a component nothing
 * points at cannot be added to one -- see `routeToReach` in canvas/direction.js. The action either
 * puts the component back in (if this path was told to leave it out) or turns round the connectors
 * between the path and it, and says which of the two it did. The second changes the *diagram*, and
 * the notification has to say so, because a connector drawn backwards is wrong for every path.
 */
const addToPath = (slot) => ({
  id: `add-to-path-${slot}`,
  /* Resolved against the context, because a row named after a path can only be named at the moment
     the menu opens. Falls back to a positional name so a row can never render blank. */
  label: (ctx) => ctx.scenarios?.[slot]?.name ?? `Path ${slot + 1}`,
  /* Hidden rather than greyed for a path that does not exist: an empty slot is not a thing the user
     could enable, and five dead rows under every right-click is noise. */
  visible: (ctx) => Boolean(ctx.scenarios?.[slot]),
  enabled: (ctx) =>
    ctx.scenarios?.[slot]?.sourceId
      ? true
      : 'This path has no start yet — choose one in the walkthrough drawer first, or it has nothing to be reachable from.',
  run: (ctx) =>
    ctx.actions.includeInPath(ctx.scenarios[slot].id, {
      nodeId: ctx.node?.id ?? null,
      edgeId: ctx.edge?.id ?? null,
    }),
})

const ADD_TO_PATH_SLOTS = 6

/* One list, two scopes. Ordered right/down first because those are the two directions a
   diagram is actually read in, and so the two that fix a real one. */
const FLOW_ROWS = [
  ['right', 'Left to right', 'Data flows towards the right of the diagram.'],
  ['down', 'Top to bottom', 'Data flows down the diagram. Use this for a vertical stack.'],
  ['left', 'Right to left', 'Data flows towards the left of the diagram.'],
  ['up', 'Bottom to top', 'Data flows up the diagram.'],
]

/* Two components, because the selection's own bounding box is the reference: with one
   selected the box *is* that card and every alignment is a no-op that still marks the
   document dirty. See `alignTargets`. */
function alignable(ctx) {
  const count = alignTargets(ctx).length
  if (count >= 2) return true
  return count === 1
    ? 'Select a second component or zone — aligning one to itself does nothing.'
    : 'Select two or more components or zones to align them.'
}

/* Three, because distributing two is the identity: one gap is already equal to itself.
   See `distributeNodes`. */
function distributable(ctx) {
  const count = alignTargets(ctx).length
  if (count >= 3) return true
  return `Select three or more components or zones to space them out — ${count} cannot be distributed.`
}

export const COMMANDS = [
  {
    id: 'inspect',
    label: 'Open in Edit-Stage',
    menus: [NODE_MENU],
    group: 'inspect',
    /* First, and deliberately: right-click used to *be* this, so anyone who learned the
       old behaviour finds it where their muscle memory already points. */
    enabled: (ctx) =>
      ctx.stack
        ? 'Expand the group to inspect one of its components.'
        : Boolean(ctx.node) || 'Right-click a component to inspect it.',
    run: (ctx) => ctx.actions.inspect(ctx.node),
  },
  {
    id: 'docs',
    label: 'Segment docs',
    menus: [NODE_MENU],
    group: 'inspect',
    enabled: (ctx) =>
      Boolean(ctx.node?.data?.docsUrl) ||
      'Segment has no documentation page for this component.',
    run: (ctx) => ctx.actions.openUrl(ctx.node.data.docsUrl),
  },
  {
    id: 'nuances',
    label: 'Nuances',
    menus: [NODE_MENU],
    group: 'inspect',
    enabled: (ctx) => Boolean(ctx.node?.data?.kind) || 'Nuances are recorded per component type.',
    run: (ctx) => ctx.actions.nuances(ctx.node),
  },

  {
    id: 'duplicate',
    label: 'Duplicate',
    menus: [NODE_MENU],
    group: 'edit',
    enabled: needsComponents('duplicate'),
    run: (ctx) => ctx.actions.duplicate(componentTargets(ctx)),
  },
  {
    id: 'copy',
    label: 'Copy',
    shortcut: 'mod+c',
    menus: [NODE_MENU],
    group: 'edit',
    enabled: needsComponents('copy'),
    run: (ctx) => ctx.actions.copy(componentTargets(ctx)),
  },
  {
    id: 'cut',
    label: 'Cut',
    shortcut: 'mod+x',
    menus: [NODE_MENU],
    group: 'edit',
    enabled: needsComponents('cut'),
    run: (ctx) => ctx.actions.cut(componentTargets(ctx)),
  },
  {
    id: 'paste',
    label: 'Paste',
    shortcut: 'mod+v',
    menus: both,
    group: 'edit',
    /* Asked of the clipboard rather than remembered from the last copy, so a clip put
       there by the *other* tab enables this one -- which is the whole of cross-canvas
       paste from this side. */
    enabled: (ctx) => Boolean(ctx.clipboard) || 'There is nothing on the clipboard.',
    run: (ctx) => ctx.actions.paste(ctx.clipboard, ctx.position),
  },
  {
    id: 'delete',
    label: 'Delete',
    menus: [NODE_MENU],
    group: 'edit',
    /* Not `needsComponents`: a zone *can* be deleted, and the canvas already has the
       rule that stops one going with its children still inside it (`onBeforeDelete`).
       Answering here as well would be a second copy of that rule. */
    enabled: (ctx) => selectionOf(ctx).length > 0 || 'Select something to delete.',
    run: (ctx) => ctx.actions.remove(selectionOf(ctx)),
  },

  {
    id: 'arrange',
    label: 'Arrange',
    menus: [NODE_MENU],
    group: 'arrange',
    /* Zones included, unlike align: which of two overlapping regions is drawn in front is
       exactly the question a zone raises, and the request says this applies to anything on
       the canvas. */
    enabled: (ctx) => selectionOf(ctx).length > 0 || 'Select something to restack.',
    children: [
      /*
       * `]` is forward because it is the rightward bracket and forward is rightward in every
       * stacking UI. The modified pair is the same direction taken all the way.
       *
       * Alt, not Shift, for that pair -- and this is a correction. `mod+shift+[` and
       * `mod+shift+]` are how Chrome and Safari switch browser tabs, and the browser wins:
       * pressing them moved the user off the app entirely rather than restacking anything.
       * `mod+alt+[` is unclaimed on both. (Note `mod+alt+left/right` *is* tab switching on
       * some builds, which is why this is on the brackets and not the arrows.)
       */
      arrangeMove('arrange-front', 'Bring to front', 'mod+alt+]'),
      arrangeMove('arrange-forward', 'Bring forward', 'mod+]'),
      arrangeMove('arrange-backward', 'Send backward', 'mod+['),
      arrangeMove('arrange-back', 'Send to back', 'mod+alt+['),
    ],
  },
  {
    id: 'align',
    label: 'Align',
    menus: [NODE_MENU],
    group: 'arrange',
    enabled: alignable,
    children: [
      alignTo('left', 'Left'),
      alignTo('centerX', 'Center'),
      alignTo('right', 'Right'),
      alignTo('top', 'Top'),
      alignTo('middleY', 'Middle'),
      alignTo('bottom', 'Bottom'),
    ],
  },
  {
    id: 'distribute',
    label: 'Distribute',
    menus: [NODE_MENU],
    group: 'arrange',
    enabled: distributable,
    children: [
      distributeOn('horizontal', 'Horizontally'),
      distributeOn('vertical', 'Vertically'),
    ],
  },
  /*
   * Auto-Align. No `menus`: this is not a per-selection action, it runs over the whole
   * diagram, so its home is the always-on Panel button in Canvas.jsx rather than a
   * right-click row -- there is no selection for a right-click on one component or zone to
   * be "about". Still a command, not a bare button handler, so it goes through the same
   * `runCommand` path (and gets a reason string for free if it is ever wired to a shortcut).
   * `standalone: true` tells the reachability check in registry.test.js that its dedicated
   * button, not a menu or a keystroke, is how this one is meant to be found.
   */
  {
    id: 'auto-align',
    label: 'Auto-Align',
    group: 'arrange',
    standalone: true,
    enabled: (ctx) => (ctx.nodes?.length ?? 0) > 0 || 'There is nothing on this diagram yet.',
    run: (ctx) => ctx.actions.autoAlign(ctx.nodes),
  },

  /*
   * Editing a table's grid.
   *
   * A submenu, and hidden entirely unless the right-click landed on a cell -- six rows about
   * columns on the menu for a destination would be noise on every use, and the parent's `visible`
   * is what keeps the whole branch out of the way.
   *
   * The row and column come from the click rather than from a selection, because a table is one
   * node: selecting it says nothing about which of its nine cells is meant, and the pointer does.
   * Adding is offered from the cell too, so "another row under this one" is one gesture -- the two
   * `+` affordances on the node itself only ever append.
   */
  {
    id: 'table',
    label: 'Table',
    menus: [NODE_MENU],
    group: 'edit',
    visible: (ctx) => Boolean(ctx.cell),
    enabled: (ctx) => Boolean(ctx.cell) || 'Right-click a cell to edit the grid.',
    children: [
      tableEdit('insert-row-above', 'Insert row above'),
      tableEdit('insert-row-below', 'Insert row below'),
      tableEdit('insert-column-left', 'Insert column left'),
      tableEdit('insert-column-right', 'Insert column right'),
      tableEdit('delete-row', 'Delete row', (ctx) =>
        ctx.cell.rows > 1 || 'A table needs at least one row.',
      ),
      tableEdit('delete-column', 'Delete column', (ctx) =>
        ctx.cell.columns > 1 || 'A table needs at least one column.',
      ),
      /* The way back from a row dragged shorter than its own text. Also on the divider itself, as
         a double-click, but that one is only findable once you know it is there. */
      tableEdit('fit-row', 'Fit row to its text'),
    ],
  },

  {
    id: 'group',
    label: 'Group',
    menus: [NODE_MENU],
    group: 'group',
    /* Not `needsComponents`: two is the floor, and "select a component to group" would be
       the wrong sentence for a selection of exactly one. */
    enabled: (ctx) =>
      componentTargets(ctx).length >= 2 ||
      'Select two or more components to group them — a group of one moves like a component.',
    run: (ctx) => ctx.actions.group(componentTargets(ctx)),
  },
  {
    id: 'ungroup',
    label: 'Ungroup',
    menus: [NODE_MENU],
    group: 'group',
    /* Hidden rather than greyed when nothing in the selection is grouped: on a diagram
       where nobody has made a group, a permanently dead "Ungroup" is noise on every
       right-click. */
    visible: (ctx) => Boolean(ctx.grouped),
    enabled: () => true,
    run: (ctx) => ctx.actions.ungroup(componentTargets(ctx)),
  },
  {
    id: 'lock',
    label: 'Lock placement',
    menus: [NODE_MENU],
    group: 'group',
    /* One item, not two: Lock and Unlock in the same menu means reading both to find out
       which applies, and the answer is already on screen. It flips to Unlock once anything
       in the selection is pinned -- so a mixed selection unlocks, which is the direction
       that cannot lose work. */
    visible: (ctx) => !ctx.locked,
    enabled: (ctx) => selectionOf(ctx).length > 0 || 'Select something to lock.',
    run: (ctx) => ctx.actions.lock(selectionOf(ctx), true),
  },
  {
    id: 'unlock',
    label: 'Unlock placement',
    menus: [NODE_MENU],
    group: 'group',
    visible: (ctx) => Boolean(ctx.locked),
    enabled: () => true,
    run: (ctx) => ctx.actions.lock(selectionOf(ctx), false),
  },

  {
    id: 'expand-group',
    label: 'Expand group',
    menus: [NODE_MENU],
    group: 'edit',
    /* Hidden rather than greyed, unlike everything else here. A stack is the only node
       this applies to, and on any other node the item is not unavailable -- it is
       meaningless, and a greyed row with "this is not a group" is noise on every
       right-click. */
    visible: (ctx) => Boolean(ctx.stack),
    enabled: () => true,
    run: (ctx) => ctx.actions.expandGroup(ctx.stack),
  },

  {
    id: 'line-style',
    label: 'Line style',
    menus: [EDGE_MENU],
    group: 'route',
    enabled: (ctx) => Boolean(ctx.edge) || 'Right-click a connector to restyle it.',
    children: [
      lineStyle('orthogonal', 'Right-angle', 'Turns at right angles. Reads as a pipeline.'),
      lineStyle('curved', 'Curved', 'Bows out. Easiest to follow where several lines cross.'),
      lineStyle('straight', 'Straight', 'Point to point, no turns.'),
    ],
  },
  {
    id: 'straighten',
    label: 'Straighten',
    menus: [EDGE_MENU],
    group: 'route',
    /* Hidden rather than greyed on a connector with no bends: "remove the bends" on a line that
       has none is not unavailable, it is meaningless, and a permanently dead row on most edges is
       noise on every right-click. */
    visible: (ctx) => Boolean(ctx.edge?.data?.waypoints?.length),
    enabled: () => true,
    run: (ctx) => ctx.actions.route(ctx.edge.id, []),
  },
  {
    id: 'flow',
    label: 'Flow',
    menus: [EDGE_MENU],
    group: 'route',
    /*
     * The direct way to say which way a connector runs, and the one to reach for.
     *
     * "Reverse direction" below is the same operation stated relatively, and relative is the
     * harder thing to reason about on a diagram with forty lines: you have to know which way
     * it points now to know what reversing gets you. "Data flows top to bottom" is absolute
     * and is a property of the diagram in front of you, so it is right whether the connector
     * was drawn forwards or backwards -- and it is a no-op on the ones already correct, which
     * is what makes it safe to use on a whole selection.
     */
    enabled: (ctx) => Boolean(ctx.edge) || 'Right-click a connector to set which way it flows.',
    children: FLOW_ROWS.map(([id, label, hint]) => flowOnEdge(id, label, hint)),
  },
  {
    id: 'add-to-path',
    label: 'Add to path',
    menus: [NODE_MENU, EDGE_MENU],
    group: 'route',
    /* Hidden with no paths at all, rather than greyed. "Add to path" on a diagram that has none is
       not an action waiting on a condition -- there is nothing to add to -- and the drawer is where
       a path gets made. */
    visible: (ctx) => (ctx.scenarios?.length ?? 0) > 0,
    enabled: (ctx) =>
      ctx.node || ctx.edge
        ? true
        : 'Right-click a component or a connector to get it onto a path.',
    children: [
      ...Array.from({ length: ADD_TO_PATH_SLOTS }, (_, slot) => addToPath(slot)),
      {
        /*
         * Past the sixth path, say so rather than quietly listing the first six.
         *
         * `inert`: a row that exists to be read, never to be run. It carries no `run` because there
         * is nothing for it to do -- the honest response to "there are more paths than fit here" is
         * to name the place they can be reached, not to invent a way to open a drawer from inside a
         * submenu. Its `enabled` always refuses, so `runCommand` reports the reason if a keystroke
         * ever finds it.
         */
        id: 'add-to-path-more',
        inert: true,
        label: (ctx) => `${(ctx.scenarios?.length ?? 0) - ADD_TO_PATH_SLOTS} more…`,
        visible: (ctx) => (ctx.scenarios?.length ?? 0) > ADD_TO_PATH_SLOTS,
        enabled: () =>
          'This menu lists the first six paths. Open the walkthrough drawer to reach the rest.',
      },
    ],
  },
  {
    id: 'flow-all',
    label: 'Flow of every connector',
    menus: [PANE_MENU],
    group: 'route',
    /* The bulk form, for a diagram whose connectors were all drawn the same wrong way -- which
       is what laying components out and dragging each line back to the previous card produces.
       Only the ones running against the direction chosen are touched, so this is idempotent
       and one undo puts the whole diagram back. */
    enabled: (ctx) => ctx.edges?.length > 0 || 'There are no connectors on this diagram yet.',
    children: FLOW_ROWS.map(([id, label, hint]) => flowOnAll(id, label, hint)),
  },
  {
    id: 'reverse-edge',
    label: 'Reverse direction',
    menus: [EDGE_MENU],
    group: 'route',
    /*
     * The fix for the commonest drawing mistake on this canvas.
     *
     * `ConnectionMode.Loose` makes `source` whichever end the drag started from, so drawing
     * a connector from a destination back towards the source that feeds it stores it
     * pointing the wrong way -- and the walkthrough only ever walks source to target, so the
     * event stops there. With the arrowheads that is now visible; this is what corrects it.
     *
     * A discovered connector is refused for the same reason it cannot be deleted: its
     * direction is a fact read from the workspace rather than a drawing decision.
     */
    enabled: (ctx) =>
      !ctx.edge
        ? 'Right-click a connector to reverse it.'
        : (ctx.edge.data?.discovered ?? ctx.edge.discovered) === true
          ? 'This connection was read from the workspace, so its direction is a fact rather than a choice.'
          : true,
    run: (ctx) => ctx.actions.reverseEdges([ctx.edge.id]),
  },
  {
    id: 'reverse-all-edges',
    label: 'Reverse every connector',
    menus: [PANE_MENU],
    group: 'route',
    /*
     * For a diagram drawn end-to-start, which is a whole class of diagram rather than a
     * freak case: it is what you get by laying out the components right to left, or by
     * consistently dragging each connector from the card you just placed back to the one
     * before it.
     *
     * Deliberately not "work the directions out for me". Nothing local to a connector can
     * tell a backwards chain from a legitimate fan-in, so an inferring version turns correct
     * diagrams into wrong ones -- see the header of canvas/direction.js. This says exactly
     * what it does, and one undo puts it back.
     */
    enabled: (ctx) => ctx.edges?.length > 0 || 'There are no connectors on this diagram yet.',
    run: (ctx) => ctx.actions.reverseEdges(null),
  },
  {
    id: 'delete-edge',
    label: 'Delete connector',
    menus: [EDGE_MENU],
    group: 'edit',
    /* A discovered edge is a fact read from the customer's workspace rather than a choice, so it
       is not deletable -- the canvas sets `deletable: false` on it and this says why instead of
       letting the click do nothing. */
    enabled: (ctx) =>
      !ctx.edge
        ? 'Right-click a connector to delete it.'
        : ctx.edge.deletable === false
          ? 'This connection was read from the workspace, so it is a fact rather than a choice. Disconnect it in Segment.'
          : true,
    run: (ctx) => ctx.actions.removeEdges([ctx.edge.id]),
  },

  {
    id: 'undo',
    label: 'Undo',
    shortcut: 'mod+z',
    menus: [PANE_MENU],
    group: 'history',
    enabled: (ctx) => Boolean(ctx.canUndo) || 'Nothing to undo yet.',
    run: (ctx) => ctx.actions.undo(),
  },
  {
    id: 'redo',
    label: 'Redo',
    /* Both bindings. `mod+y` is what the request names and what a Windows keyboard
       expects; `mod+shift+z` is what a Mac one does, and this app is used on both. */
    shortcut: ['mod+y', 'mod+shift+z'],
    menus: [PANE_MENU],
    group: 'history',
    enabled: (ctx) => Boolean(ctx.canRedo) || 'Nothing to redo.',
    run: (ctx) => ctx.actions.redo(),
  },

  {
    id: 'select-all',
    label: 'Select all',
    shortcut: 'mod+a',
    menus: null,
    group: 'canvas',
    enabled: () => true,
    run: (ctx) => ctx.actions.selectAll(),
  },
  {
    id: 'save',
    label: 'Save',
    shortcut: 'mod+s',
    menus: null,
    group: 'canvas',
    /* Not gated on being dirty: a diagram that has never been saved is not dirty by
       `useDiagrams`' reckoning (there is no saved print to differ from), and cmd-s
       refusing on a brand-new diagram is the one time it is most needed. */
    enabled: (ctx) => ctx.canSave !== false || 'A save is already in flight.',
    run: (ctx) => ctx.actions.save(),
  },
]

/** Every command in the table, parents and children alike, depth-first in table order. */
export function flattenCommands(commands = COMMANDS) {
  const out = []
  for (const command of commands) {
    out.push(command)
    if (command.children) out.push(...flattenCommands(command.children))
  }
  return out
}

/* Children included, so `runCommand('align-left')` and the keyboard both resolve a nested
   command by id without the caller knowing it is nested. */
const BY_ID = new Map(flattenCommands().map((command) => [command.id, command]))

export function commandById(id) {
  return BY_ID.get(id) ?? null
}

/**
 * The selection a command acts on.
 *
 * A right-click inside a multi-selection acts on the whole selection; a right-click on
 * an unselected node acts on that node alone. That is what every canvas tool does, and
 * the alternative -- acting on the selection regardless -- silently copies four nodes
 * when the user aimed at a fifth.
 */
export function selectionOf(ctx) {
  const selected = ctx?.selection ?? []
  if (ctx?.node && !selected.includes(ctx.node.id)) return [ctx.node.id]
  return selected
}

/**
 * The part of the selection that copy, cut and duplicate can act on.
 *
 * Zones are dropped. One cannot be copied in any meaningful sense: it is a region, its
 * geometry is only true relative to its parent, and its children are the components a
 * user pointing at it actually means. Answered here rather than left to `copyNodes`,
 * which also filters them, so the menu can grey the item with a reason instead of the
 * user choosing Copy and nothing appearing to happen.
 */
export function componentTargets(ctx) {
  const byId = new Map((ctx?.nodes ?? []).map((node) => [node.id, node]))
  return selectionOf(ctx).filter((id) => byId.get(id)?.type !== 'zone')
}

/**
 * The part of the selection that align and distribute can act on.
 *
 * Unlike `componentTargets`, a zone stays in: `alignNodes`/`distributeNodes` already convert
 * every node to absolute coordinates before computing anything, so a zone's box is exactly as
 * usable as a component's, and there is no version of "line up these two zones' tops" that a
 * user could mean by selecting components instead. Only a synthetic group-stack id is dropped
 * -- it draws as one card but is not a node the document actually has a position for.
 */
export function alignTargets(ctx) {
  return selectionOf(ctx).filter((id) => !isGroupStackId(id))
}

/* Three refusals rather than one, because "there is no component here" has three
   different causes and only the bare one is the user's own oversight. A stack and a zone
   each have components in them, and the sentence says how to reach them. */
function needsComponents(verb) {
  return (ctx) => {
    if (componentTargets(ctx).length > 0) return true
    if (ctx?.stack) return `Expand the group to ${verb} the components in it.`
    if (selectionOf(ctx).length > 0) {
      return `A zone is a region, not a component — ${verb} the components inside it.`
    }
    return `Select a component to ${verb}.`
  }
}

/** `{enabled, reason}` -- the reason is null when it is enabled. */
export function commandState(command, ctx) {
  const verdict = command.enabled?.(ctx ?? {}) ?? true
  if (verdict === true) return { enabled: true, reason: null }
  return { enabled: false, reason: typeof verdict === 'string' ? verdict : null }
}

/**
 * The items for one menu, in table order, each already resolved against the context.
 *
 * `group` comes through so the menu can draw separators without knowing what the groups
 * mean.
 */
export function commandsFor(menu, ctx) {
  return COMMANDS.filter(
    (command) => command.menus?.includes(menu) && (command.visible?.(ctx ?? {}) ?? true),
  ).map((command) => resolve(command, ctx))
}

/* A submenu's children carry no `menus` of their own -- they appear wherever their parent
   does, because a nested item that could be in a different menu from the branch holding it
   is not a nested item. `children: null` on a leaf so the menu can test one field. */
function resolve(command, ctx) {
  return {
    id: command.id,
    /*
     * A function when the row is named after something in the document rather than after an
     * operation -- "Path 4" is the user's own word for it and only exists at the moment the menu
     * opens. The *id* stays static regardless, because `runCommand` resolves ids against a fixed
     * table and a row whose id was invented per render could never be run from it.
     */
    label: typeof command.label === 'function' ? command.label(ctx ?? {}) : command.label,
    shortcut: command.shortcut ?? null,
    hint: command.hint ?? null,
    group: command.group,
    /*
     * What hovering this row should show on the canvas, or null.
     *
     * Resolved here against the same context `enabled` and `run` get, so the menu stays a
     * renderer: it hands the value back on hover and knows nothing about what a preview is.
     * A row whose command declares none reads as null and the menu does nothing, which is
     * every command but the flow directions.
     */
    preview: command.preview?.(ctx ?? {}) ?? null,
    ...commandState(command, ctx),
    children: command.children
      ? command.children
          .filter((child) => child.visible?.(ctx ?? {}) ?? true)
          .map((child) => resolve(child, ctx))
      : null,
  }
}

/**
 * Run a command by id, whatever asked for it.
 *
 * Returns `{ran: false, reason}` rather than throwing when it is unavailable: pressing
 * a shortcut that cannot apply should say why, and the caller has the toast. Checked
 * here and not only at the call site so the menu, the keyboard and Stage 7's panel
 * cannot each get it slightly wrong.
 */
export function runCommand(id, ctx) {
  const command = BY_ID.get(id)
  if (!command) return { ran: false, reason: null }

  const state = commandState(command, ctx)
  if (!state.enabled) return { ran: false, reason: state.reason }

  /* A submenu has nothing to run. Reported as "did not run, no reason" rather than
     throwing, because the menu will not offer it as clickable and a keystroke cannot reach
     it -- so this is only ever hit by a caller naming a branch by id. */
  if (!command.run) return { ran: false, reason: null }

  command.run(ctx)
  return { ran: true, reason: null }
}

/* Keys whose modified form is a different character, and therefore a different `event.key`.
   Only the two brackets so far. Both Shift and Alt change what they produce -- `shift+[` is `{`
   and, on a Mac, `alt+[` is `“` -- so the restacking binds could not be matched on `event.key`
   at all. */
const PHYSICAL_KEYS = { '[': 'BracketLeft', ']': 'BracketRight' }

/**
 * Does a keyboard event match a shortcut?
 *
 * Modifiers are matched exactly, in both directions: `mod+z` must not fire on
 * `mod+shift+z`, because that is redo. A subset match -- testing only the modifiers the
 * shortcut names -- makes undo and redo the same keystroke and is the obvious way to
 * write this wrongly.
 *
 * `mod` is Command or Control, whichever the platform uses. Both are accepted rather
 * than sniffing the user agent: a Mac user with an external PC keyboard presses Control,
 * and there is no shortcut here where the two mean different things.
 */
export function matchesShortcut(event, shortcut) {
  /* Split off the last part rather than on every `+`, so a shortcut *on* the `+` key would
     still be expressible. The bracket binds made this worth being careful about. */
  const parts = String(shortcut).toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const wanted = new Set(parts.slice(0, -1))

  /*
   * `event.key` reports what the keystroke produced, and shift changes that: pressing
   * shift and `[` together gives `{`. So `mod+shift+[` compared against `event.key` could
   * never match, which is how three of the four arrange shortcuts would have silently done
   * nothing. `event.code` names the physical key and is unaffected by shift.
   *
   * Either is accepted rather than only the code, because `code` is layout-dependent in the
   * other direction -- on a layout where brackets are not on those two keys, what the user
   * pressed to *get* a bracket is what they will expect to work.
   */
  const physical = PHYSICAL_KEYS[key]
  const pressed = String(event.key ?? '').toLowerCase()
  if (physical) {
    if (pressed !== key && event.code !== physical) return false
  } else if (pressed !== key) {
    return false
  }
  if (wanted.has('mod') !== Boolean(event.metaKey || event.ctrlKey)) return false
  if (wanted.has('shift') !== Boolean(event.shiftKey)) return false
  if (wanted.has('alt') !== Boolean(event.altKey)) return false
  return true
}

/** The command a keystroke invokes, or null. Nested commands included. */
export function commandForEvent(event) {
  for (const command of flattenCommands()) {
    const shortcuts = toList(command.shortcut)
    if (shortcuts.some((shortcut) => matchesShortcut(event, shortcut))) return command
  }
  return null
}

/**
 * A shortcut as a user reads it: `⌘Z` on a Mac, `Ctrl+Z` elsewhere.
 *
 * Takes `mac` as an argument rather than reading the platform, so it is pure and the
 * caller resolves it once.
 */
export function formatShortcut(shortcut, { mac = false } = {}) {
  const first = toList(shortcut)[0]
  if (!first) return ''

  const parts = String(first).split('+')
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map((part) => {
    if (part === 'mod') return mac ? '⌘' : 'Ctrl'
    if (part === 'shift') return mac ? '⇧' : 'Shift'
    if (part === 'alt') return mac ? '⌥' : 'Alt'
    return part
  })

  const printable = key.length === 1 ? key.toUpperCase() : key
  return mac ? [...modifiers, printable].join('') : [...modifiers, printable].join('+')
}

function toList(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
