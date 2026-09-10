import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  COMMANDS,
  EDGE_MENU,
  NODE_MENU,
  PANE_MENU,
  commandForEvent,
  commandState,
  commandsFor,
  componentTargets,
  flattenCommands,
  formatShortcut,
  matchesShortcut,
  runCommand,
  selectionOf,
} from './registry.js'

const node = (id = 'destination:1', data = {}) => ({
  id,
  type: 'segmentNode',
  data: { id, kind: 'destination', name: 'Braze', docsUrl: 'https://segment.com/docs/x', ...data },
})

function context(extra = {}) {
  const actions = {
    inspect: vi.fn(),
    openUrl: vi.fn(),
    nuances: vi.fn(),
    duplicate: vi.fn(),
    copy: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    remove: vi.fn(),
    expandGroup: vi.fn(),
    lineStyle: vi.fn(),
    route: vi.fn(),
    removeEdges: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    selectAll: vi.fn(),
    save: vi.fn(),
  }
  return { node: node(), nodes: [node()], selection: [], actions, ...extra }
}

const zone = (id = 'zone-connections') => ({
  id,
  type: 'zone',
  data: { id: 'connections', label: 'Connections' },
})

const idsIn = (menu, ctx) => commandsFor(menu, ctx).map((item) => item.id)
const find = (menu, ctx, id) => commandsFor(menu, ctx).find((item) => item.id === id)

describe('the table', () => {
  it('gives every command a run and an enabled', () => {
    /* An it.each over the table, so a command added later without one fails here rather
       than as a dead menu row or a crash on a keystroke.

       Submenu parents are the exception, and only for `run`: "Align" is a branch, not an
       action, and giving it one would mean a mis-aimed click on the parent silently
       rearranging the diagram. They still need an `enabled`, because the branch's gate is
       what refuses the whole thing once with a reason. */
    for (const command of flattenCommands()) {
      if (!command.children) expect(typeof command.run, command.id).toBe('function')
      else expect(command.run, command.id).toBeUndefined()
      expect(typeof command.enabled, command.id).toBe('function')
      expect(command.label, command.id).toBeTruthy()
    }
  })

  it('has no two commands sharing an id or a shortcut', () => {
    /* Flattened, so a nested command cannot quietly reuse a parent's id or shadow another
       branch's shortcut -- both resolve through one map and one keystroke scan. */
    const all = flattenCommands()
    const ids = all.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)

    const shortcuts = all.flatMap((command) =>
      Array.isArray(command.shortcut) ? command.shortcut : command.shortcut ? [command.shortcut] : [],
    )
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('leaves no command with no way to invoke it', () => {
    /* A command in no menu and under no shortcut is unreachable code that still reads as a
       feature from the table. `menus: null` is legal -- save and select-all are both -- but
       only because those two have keystrokes. */
    for (const command of COMMANDS) {
      const reachable =
        Boolean(command.menus?.length) || Boolean(command.shortcut) || Boolean(command.children)
      expect(reachable, command.id).toBe(true)
    }
  })
})

describe('the wiring to the app', () => {
  /*
   * The one thing this module's purity cannot check for itself, and the shape of the bug
   * the user reported: every test above hands `run` a mock `actions`, so a command calling
   * `ctx.actions.dupliate` passes all of them and then does nothing at all on the real
   * canvas -- silently, because reading a missing key gives undefined and calling it is the
   * only error, one frame later, inside an onClick.
   *
   * Read from source rather than by importing AppShell, which pulls in React Flow and the
   * whole component tree; there is no jsdom in this project, so it could not be rendered
   * anyway. Same approach as the topology guards that read JS from Python.
   */
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const registrySource = source('./registry.js')
  const appSource = source('../AppShell.jsx')

  it('names only actions the app actually supplies', () => {
    const named = [
      ...new Set([...registrySource.matchAll(/ctx\.actions\.(\w+)/g)].map((match) => match[1])),
    ]
    /* Guards the regex itself: a rename that broke the match would otherwise assert over an
       empty list and pass. */
    expect(named).toContain('duplicate')
    expect(named.length).toBeGreaterThanOrEqual(COMMANDS.length - 2)

    /* Just the actions object, so a `duplicate` mentioned anywhere else in a 1000-line file
       -- the callback that defines it, a comment, a prop -- cannot stand in for the key. */
    const start = appSource.indexOf('const actions = useMemo')
    const end = appSource.indexOf('const commandContext')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const supplied = appSource.slice(start, end)

    for (const name of named) {
      expect(supplied, name).toMatch(new RegExp(`^\\s*${name}\\s*[:,]`, 'm'))
    }
  })

  it('supplies the context keys the enablement rules read', () => {
    /* The other half: `canUndo` misspelt in the context greys Undo forever, and the reason
       printed under it ("Nothing to undo yet.") is plausible enough that nobody reports it. */
    const start = appSource.indexOf('const commandContext = useMemo')
    const supplied = appSource.slice(start, appSource.indexOf('const menuContext'))
    expect(start).toBeGreaterThan(0)

    for (const key of ['nodes', 'selection', 'clipboard', 'canUndo', 'canRedo', 'canSave']) {
      expect(supplied, key).toMatch(new RegExp(`^\\s*${key}\\s*[:,]`, 'm'))
    }
  })
})

describe('commandsFor', () => {
  it('opens the node menu with the inspector, which is what right-click used to do', () => {
    expect(idsIn(NODE_MENU, context())[0]).toBe('inspect')
  })

  it('keeps the node commands out of the pane menu', () => {
    const pane = idsIn(PANE_MENU, context({ node: null }))
    expect(pane).toContain('paste')
    expect(pane).toContain('undo')
    expect(pane).not.toContain('duplicate')
    expect(pane).not.toContain('docs')
  })

  it('leaves the keyboard-only commands out of both', () => {
    /* Save and select-all are already in the header and on the canvas. A menu listing
       everything the app can do is one nobody reads to the bottom of. */
    const ctx = context()
    expect(idsIn(NODE_MENU, ctx)).not.toContain('save')
    expect(idsIn(PANE_MENU, ctx)).not.toContain('select-all')
  })

  it('greys an unavailable command and says why', () => {
    const paste = find(NODE_MENU, context({ clipboard: null }), 'paste')
    expect(paste.enabled).toBe(false)
    expect(paste.reason).toBe('There is nothing on the clipboard.')
  })

  it('explains a component with no documentation page rather than hiding it', () => {
    /* Greyed with a reason, not absent: "Segment docs" missing from the menu reads as a
       bug in the app, where the greyed row is a fact about the component. */
    const docs = find(NODE_MENU, context({ node: node('custom:1', { docsUrl: null }) }), 'docs')
    expect(docs.enabled).toBe(false)
    expect(docs.reason).toMatch(/no documentation/i)
  })

  it('shows Expand group only on a stack', () => {
    expect(idsIn(NODE_MENU, context())).not.toContain('expand-group')
    expect(idsIn(NODE_MENU, context({ stack: { key: 'destination:email' } }))).toContain(
      'expand-group',
    )
  })

  it('sends a stack to the group rather than refusing flatly', () => {
    /* The stack's id is not in the document, so none of these can act on it. Saying
       "select a component" over forty folded components is true and useless. */
    const ctx = context({ node: null, stack: { data: { key: 'destination:email' } } })
    expect(find(NODE_MENU, ctx, 'copy').reason).toBe(
      'Expand the group to copy the components in it.',
    )
    expect(find(NODE_MENU, ctx, 'inspect').reason).toBe(
      'Expand the group to inspect one of its components.',
    )
  })

  it('carries the shortcut through for the menu to print', () => {
    expect(find(NODE_MENU, context(), 'copy').shortcut).toBe('mod+c')
    expect(find(NODE_MENU, context(), 'inspect').shortcut).toBe(null)
  })
})

describe('componentTargets', () => {
  const onZone = (extra = {}) =>
    context({ node: zone(), nodes: [node('a'), zone()], selection: [], ...extra })

  it('drops a zone from what copy acts on', () => {
    expect(componentTargets(onZone({ selection: ['a', 'zone-connections'] }))).toEqual(['a'])
  })

  it('greys Copy on a zone with the reason a zone is not a component', () => {
    /* The refusal that would otherwise read "Select a component to copy." while a zone
       plainly *is* selected -- true of the clipboard, and useless to the user. */
    const copy = find(NODE_MENU, onZone(), 'copy')
    expect(copy.enabled).toBe(false)
    expect(copy.reason).toBe(
      'A zone is a region, not a component — copy the components inside it.',
    )
  })

  it('still says nothing is selected when nothing is', () => {
    expect(find(PANE_MENU, context({ node: null }), 'paste')).toBeTruthy()
    const ctx = context({ node: null, selection: [], nodes: [] })
    expect(runCommand('copy', ctx).reason).toBe('Select a component to copy.')
  })

  it('lets Delete through on a zone, which the canvas rule owns', () => {
    /* Not a copy of `onBeforeDelete`'s "a zone cannot go while its children are inside
       it" -- two statements of one rule is how they drift apart. */
    const ctx = onZone({ selection: ['zone-connections'] })
    expect(find(NODE_MENU, ctx, 'delete').enabled).toBe(true)
    runCommand('delete', ctx)
    expect(ctx.actions.remove).toHaveBeenCalledWith(['zone-connections'])
  })

  it('copies the components of a mixed selection rather than refusing all of it', () => {
    const ctx = onZone({ selection: ['a', 'zone-connections'] })
    runCommand('copy', ctx)
    expect(ctx.actions.copy).toHaveBeenCalledWith(['a'])
  })
})

describe('selectionOf', () => {
  it('acts on a whole multi-selection when the click was inside it', () => {
    const ctx = context({ node: node('a'), selection: ['a', 'b', 'c'] })
    expect(selectionOf(ctx)).toEqual(['a', 'b', 'c'])
  })

  it('acts on the clicked node alone when it was not selected', () => {
    /* Otherwise right-clicking a fifth node and choosing Copy silently copies the four
       that happened to still be selected. */
    const ctx = context({ node: node('e'), selection: ['a', 'b'] })
    expect(selectionOf(ctx)).toEqual(['e'])
  })

  it('falls back to the selection when there is no node, as in the pane menu', () => {
    expect(selectionOf({ selection: ['a'] })).toEqual(['a'])
    expect(selectionOf({})).toEqual([])
  })
})

describe('runCommand', () => {
  it('calls the action with what it acts on', () => {
    const ctx = context({ node: node('a'), selection: ['a', 'b'] })
    expect(runCommand('duplicate', ctx).ran).toBe(true)
    expect(ctx.actions.duplicate).toHaveBeenCalledWith(['a', 'b'])
  })

  it('opens the docs url that is already on every node', () => {
    const ctx = context()
    runCommand('docs', ctx)
    expect(ctx.actions.openUrl).toHaveBeenCalledWith('https://segment.com/docs/x')
  })

  it('refuses with the reason rather than calling the action', () => {
    const ctx = context({ canUndo: false })
    const result = runCommand('undo', ctx)
    expect(result).toEqual({ ran: false, reason: 'Nothing to undo yet.' })
    expect(ctx.actions.undo).not.toHaveBeenCalled()
  })

  it('is the same gate the menu shows, not a second opinion', () => {
    /* The point of the module: the greyed row and the refused keystroke come from one
       call, so they cannot drift into disagreeing about what is possible. */
    const ctx = context({ clipboard: null })
    expect(find(NODE_MENU, ctx, 'paste').reason).toBe(runCommand('paste', ctx).reason)
  })

  it('does nothing for an id it has never heard of', () => {
    expect(runCommand('nonsense', context()).ran).toBe(false)
  })
})

describe('commandState', () => {
  it('reads true as enabled and a string as the reason', () => {
    expect(commandState({ enabled: () => true }, {})).toEqual({ enabled: true, reason: null })
    expect(commandState({ enabled: () => 'because' }, {})).toEqual({
      enabled: false,
      reason: 'because',
    })
  })
})

describe('matchesShortcut', () => {
  const press = (key, modifiers = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  })

  it('takes either platform modifier for mod', () => {
    expect(matchesShortcut(press('c', { metaKey: true }), 'mod+c')).toBe(true)
    expect(matchesShortcut(press('c', { ctrlKey: true }), 'mod+c')).toBe(true)
  })

  it('does not fire a bare letter', () => {
    expect(matchesShortcut(press('c'), 'mod+c')).toBe(false)
  })

  it('will not let mod+shift+z fire undo', () => {
    /* The bug an accumulate-only match produces: shift is not in `mod+z`, so testing
       only the modifiers the shortcut names makes undo and redo one keystroke -- and
       the symptom is cmd-shift-z undoing, which reads as redo being broken. */
    expect(matchesShortcut(press('z', { metaKey: true, shiftKey: true }), 'mod+z')).toBe(false)
    expect(matchesShortcut(press('z', { metaKey: true, shiftKey: true }), 'mod+shift+z')).toBe(true)
    expect(matchesShortcut(press('z', { metaKey: true }), 'mod+shift+z')).toBe(false)
  })

  it('ignores case, which is what shift on a letter key produces', () => {
    expect(matchesShortcut(press('Z', { metaKey: true, shiftKey: true }), 'mod+shift+z')).toBe(true)
  })
})

describe('commandForEvent', () => {
  const press = (key, modifiers = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  })

  it('finds each of the standard shortcuts', () => {
    expect(commandForEvent(press('c', { metaKey: true })).id).toBe('copy')
    expect(commandForEvent(press('x', { metaKey: true })).id).toBe('cut')
    expect(commandForEvent(press('v', { metaKey: true })).id).toBe('paste')
    expect(commandForEvent(press('s', { metaKey: true })).id).toBe('save')
    expect(commandForEvent(press('a', { metaKey: true })).id).toBe('select-all')
    expect(commandForEvent(press('z', { metaKey: true })).id).toBe('undo')
    expect(commandForEvent(press('y', { metaKey: true })).id).toBe('redo')
  })

  it('takes both redo bindings', () => {
    expect(commandForEvent(press('z', { metaKey: true, shiftKey: true })).id).toBe('redo')
  })

  it('is null for a keystroke that is not a command', () => {
    expect(commandForEvent(press('k', { metaKey: true }))).toBe(null)
    expect(commandForEvent(press('Escape'))).toBe(null)
  })
})

describe('formatShortcut', () => {
  it('prints the platform the user is on', () => {
    expect(formatShortcut('mod+c', { mac: true })).toBe('⌘C')
    expect(formatShortcut('mod+c', { mac: false })).toBe('Ctrl+C')
    expect(formatShortcut('mod+shift+z', { mac: true })).toBe('⌘⇧Z')
  })

  it('prints the first of several bindings, so redo shows one label', () => {
    expect(formatShortcut(['mod+y', 'mod+shift+z'], { mac: true })).toBe('⌘Y')
  })

  it('is empty for a command with no shortcut', () => {
    expect(formatShortcut(null)).toBe('')
  })
})

/*
 * Submenus.
 *
 * The thing worth testing is that a branch behaves like a branch: gated once, never run, and
 * with children the menu can reach without knowing they are nested. The alternative shape --
 * a flat table with `parent:` pointers -- passes an "are the ids right" test and then leaves
 * the menu sorting children back under parents, which is where it would go wrong.
 */
describe('nested commands', () => {
  const three = () => [node('a'), node('b'), node('c')]
  const branch = (id, ctx) => find(NODE_MENU, ctx, id)

  it('offers Arrange, Align and Distribute on a component', () => {
    const ids = idsIn(NODE_MENU, context())
    expect(ids).toContain('arrange')
    expect(ids).toContain('align')
    expect(ids).toContain('distribute')
  })

  it('gives Arrange the four Lucid moves under it', () => {
    const arrange = branch('arrange', context({ selection: ['a'] }))
    expect(arrange.children.map((child) => child.id)).toEqual([
      'arrange-front',
      'arrange-forward',
      'arrange-backward',
      'arrange-back',
    ])
  })

  it('binds restacking to the brackets, and not over a browser shortcut', () => {
    /* `mod+shift+[` and `mod+shift+]` are how Chrome and Safari switch browser tabs, and the
       browser wins -- pressing them moved the user off the app rather than restacking
       anything. The modified pair is on Alt for that reason, and this test is here to stop it
       drifting back. */
    const arrange = branch('arrange', context({ selection: ['a'] }))
    const shortcuts = Object.fromEntries(
      arrange.children.map((child) => [child.id, child.shortcut]),
    )
    expect(shortcuts['arrange-forward']).toBe('mod+]')
    expect(shortcuts['arrange-backward']).toBe('mod+[')
    expect(shortcuts['arrange-front']).toBe('mod+alt+]')
    expect(shortcuts['arrange-back']).toBe('mod+alt+[')

    for (const child of arrange.children) {
      expect(child.shortcut, child.id).not.toMatch(/shift/)
    }
  })

  /* `node: null` throughout, because `selectionOf` gives a right-clicked node priority over
     the selection -- which is right (a right-click on an unselected card acts on that card)
     and would otherwise silently reduce every multi-select case below to one. */
  const many = (selection) => context({ node: null, nodes: three(), selection })

  it('refuses Align once, on the branch, rather than six times inside it', () => {
    /* The reason has to be readable without opening the submenu -- a branch that opens onto
       six greyed rows saying the same thing is six copies of one sentence. */
    const align = branch('align', many(['a']))
    expect(align.enabled).toBe(false)
    expect(align.reason).toMatch(/second component/i)
  })

  it('enables Align on two components and Distribute only on three', () => {
    expect(branch('align', many(['a', 'b'])).enabled).toBe(true)
    expect(branch('distribute', many(['a', 'b'])).enabled).toBe(false)
    expect(branch('distribute', many(['a', 'b', 'c'])).enabled).toBe(true)
  })

  it('says how many were selected when Distribute refuses', () => {
    const distribute = branch('distribute', many(['a', 'b']))
    expect(distribute.reason).toMatch(/2 cannot be distributed/)
  })

  it('runs a nested command by its own id', () => {
    const ctx = many(['a', 'b'])
    ctx.actions.align = vi.fn()
    expect(runCommand('align-centerX', ctx).ran).toBe(true)
    expect(ctx.actions.align).toHaveBeenCalledWith(['a', 'b'], 'centerX')
  })

  it('does not run a branch', () => {
    const ctx = many(['a', 'b'])
    expect(runCommand('align', ctx)).toEqual({ ran: false, reason: null })
  })

  it('finds a nested command from a keystroke', () => {
    /* Nested commands are the only ones with shortcuts that are not top level, so a
       `commandForEvent` that only walked COMMANDS would leave all four arrange binds dead. */
    const found = commandForEvent({ key: ']', code: 'BracketRight', metaKey: true })
    expect(found?.id).toBe('arrange-forward')
  })

  it('reports zones as arrangeable and as lockable, unlike align', () => {
    /* Which of two overlapping regions is in front is exactly the question a zone raises. */
    const ctx = context({ node: zone(), nodes: [zone()], selection: ['zone-connections'] })
    expect(branch('arrange', ctx).enabled).toBe(true)
    expect(find(NODE_MENU, ctx, 'lock').enabled).toBe(true)
    expect(branch('align', ctx).enabled).toBe(false)
  })
})

describe('shifted keys', () => {
  /*
   * The bug this exists to prevent: shift changes what `event.key` reports. Pressing shift
   * and `[` gives `{`, so `mod+shift+[` compared against `event.key` can never match, and
   * two of the four arrange shortcuts would have silently done nothing on every keyboard.
   */
  it('matches a modified bracket by its physical key', () => {
    /* On a Mac `alt+[` produces `“`, and `shift+[` produces `{` -- so neither could ever be
       matched against `event.key`, and all the modified restacking binds would have silently
       done nothing. */
    const alted = { key: '\u201c', code: 'BracketLeft', metaKey: true, altKey: true }
    expect(matchesShortcut(alted, 'mod+alt+[')).toBe(true)
    expect(commandForEvent(alted)?.id).toBe('arrange-back')

    expect(
      matchesShortcut({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }, 'mod+shift+['),
    ).toBe(true)
  })

  it('matches an unshifted bracket by either the key or the code', () => {
    expect(matchesShortcut({ key: '[', metaKey: true }, 'mod+[')).toBe(true)
    expect(matchesShortcut({ key: 'Unidentified', code: 'BracketLeft', metaKey: true }, 'mod+[')).toBe(true)
  })

  it('still tells the modified and unmodified binds apart', () => {
    /* Same physical key, opposite ends of the stack. A modifier check loosened to make the
       modified form match at all is the obvious way to break this -- and would make "send
       backward" and "send to back" the same keystroke. */
    const alted = { key: '\u201c', code: 'BracketLeft', metaKey: true, altKey: true }
    expect(matchesShortcut(alted, 'mod+[')).toBe(false)
    expect(matchesShortcut({ key: '[', code: 'BracketLeft', metaKey: true }, 'mod+alt+[')).toBe(false)
  })

  it('formats the brackets for both platforms', () => {
    expect(formatShortcut('mod+alt+]', { mac: true })).toBe('⌘⌥]')
    expect(formatShortcut('mod+alt+]', { mac: false })).toBe('Ctrl+Alt+]')
    expect(formatShortcut('mod+[', { mac: false })).toBe('Ctrl+[')
  })
})

/*
 * The connector menu.
 *
 * A third menu rather than more rows on the node menu: almost nothing that applies to a component
 * applies to a line, and a menu whose top half is greyed out on every use is worse than two menus.
 */
describe('the connector menu', () => {
  const edge = (extra = {}) => ({
    id: 'e1',
    source: 'src:1',
    target: 'dest:1',
    deletable: true,
    data: { discovered: false },
    ...extra,
  })
  const edgeCtx = (extra = {}) => context({ node: null, edge: edge(), ...extra })
  const inEdgeMenu = (ctx) => commandsFor(EDGE_MENU, ctx).map((item) => item.id)

  it('offers line style and delete on a connector', () => {
    const ids = inEdgeMenu(edgeCtx())
    expect(ids).toContain('line-style')
    expect(ids).toContain('delete-edge')
  })

  it('keeps the component commands out of it', () => {
    const ids = inEdgeMenu(edgeCtx())
    expect(ids).not.toContain('inspect')
    expect(ids).not.toContain('align')
    expect(ids).not.toContain('duplicate')
  })

  it('keeps the connector commands out of the node and pane menus', () => {
    const ctx = context()
    expect(idsIn(NODE_MENU, ctx)).not.toContain('line-style')
    expect(idsIn(PANE_MENU, ctx)).not.toContain('line-style')
  })

  it('lists the three styles, each with a reason to pick it', () => {
    /* Three adjectives with no explanation give the user no way to choose. The hint is what says
       right-angle reads as a pipeline and curved is followable where lines cross. */
    const branch = commandsFor(EDGE_MENU, edgeCtx()).find((item) => item.id === 'line-style')
    expect(branch.children.map((child) => child.id)).toEqual([
      'line-orthogonal',
      'line-curved',
      'line-straight',
    ])
    for (const child of branch.children) expect(child.hint, child.id).toBeTruthy()
  })

  it('applies a style to the connector that was right-clicked', () => {
    const ctx = edgeCtx()
    ctx.actions.lineStyle = vi.fn()
    expect(runCommand('line-curved', ctx).ran).toBe(true)
    expect(ctx.actions.lineStyle).toHaveBeenCalledWith('e1', 'curved')
  })

  it('shows Straighten only on a connector that has bends', () => {
    /* Greyed forever on most edges would be noise on every right-click; "remove the bends" on a
       line with none is meaningless rather than unavailable. */
    expect(inEdgeMenu(edgeCtx())).not.toContain('straighten')
    const bent = context({ node: null, edge: edge({ data: { waypoints: [{ x: 1, y: 2 }] } }) })
    expect(inEdgeMenu(bent)).toContain('straighten')
  })

  it('straightens by clearing the waypoints', () => {
    const ctx = context({ node: null, edge: edge({ data: { waypoints: [{ x: 1, y: 2 }] } }) })
    ctx.actions.route = vi.fn()
    expect(runCommand('straighten', ctx).ran).toBe(true)
    expect(ctx.actions.route).toHaveBeenCalledWith('e1', [])
  })

  it('refuses to delete a connection read from the workspace, and says why', () => {
    /* A discovered edge is a fact about the customer's workspace rather than a choice. The canvas
       already sets `deletable: false`; this says so instead of letting the click do nothing. */
    const discovered = context({
      node: null,
      edge: edge({ deletable: false, data: { discovered: true } }),
    })
    const item = commandsFor(EDGE_MENU, discovered).find((entry) => entry.id === 'delete-edge')
    expect(item.enabled).toBe(false)
    expect(item.reason).toMatch(/read from the workspace/i)
  })

  it('greys everything when the menu was somehow opened with no connector', () => {
    const empty = context({ node: null, edge: null })
    for (const item of commandsFor(EDGE_MENU, empty)) {
      expect(item.enabled, item.id).toBe(false)
      expect(item.reason, item.id).toBeTruthy()
    }
  })
})
