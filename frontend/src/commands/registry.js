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
  run: (ctx) => ctx.actions.align(componentTargets(ctx), id),
})

const distributeOn = (axis, label) => ({
  id: `distribute-${axis}`,
  label,
  enabled: distributable,
  run: (ctx) => ctx.actions.distribute(componentTargets(ctx), axis),
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

/* Two components, because the selection's own bounding box is the reference: with one
   selected the box *is* that card and every alignment is a no-op that still marks the
   document dirty. Zones are excluded before counting -- see `componentTargets`. */
function alignable(ctx) {
  const count = componentTargets(ctx).length
  if (count >= 2) return true
  return count === 1
    ? 'Select a second component — aligning one to itself does nothing.'
    : 'Select two or more components to align them.'
}

/* Three, because distributing two is the identity: one gap is already equal to itself.
   See `distributeNodes`. */
function distributable(ctx) {
  const count = componentTargets(ctx).length
  if (count >= 3) return true
  return `Select three or more components to space them out — ${count} cannot be distributed.`
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
    label: command.label,
    shortcut: command.shortcut ?? null,
    hint: command.hint ?? null,
    group: command.group,
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
