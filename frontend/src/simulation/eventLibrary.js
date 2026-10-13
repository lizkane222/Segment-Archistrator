/*
 * The Events tab's library: hand-edited payloads, the spec's own examples, and the ones a reader kept.
 *
 * Three jobs, all pure so they can be tested without a DOM:
 *
 *   - Repairing what was typed. A payload editor is a textarea, and what people paste into it is
 *     rarely JSON: a snippet copied out of `analytics.track(...)` has single quotes and bare keys, a
 *     hand edit leaves a trailing comma, a half-deleted block is missing its closing brace. Refusing
 *     every one of those would make the editor a JSON linter, so `prepareEvent` corrects what can be
 *     corrected unambiguously, *says what it changed*, and refuses only what it cannot read at all.
 *     Nothing reaches the walkthrough without passing through it.
 *   - The examples Segment's public spec documents, so a reader has realistic events to start from
 *     rather than one skeleton per type.
 *   - Which keys in a payload are identifiers identity resolution matches on, so the editor can colour
 *     them.
 */

import { identityRules } from '../canvas/nodes/IdentityRuleTable.jsx'
import { preference } from '../ui/preferences.js'
import { EVENT_TYPES, skeleton } from './payload.js'
import { componentNodes, dataOf } from './router.js'

/* --- repairing typed JSON --------------------------------------------------- */

const LITERALS = { true: 'true', false: 'false', null: 'null' }
/* Spellings from the languages people copy events out of. Each maps to its JSON meaning. */
const FOREIGN_LITERALS = {
  True: 'true',
  False: 'false',
  None: 'null',
  undefined: 'null',
  NaN: 'null',
  TRUE: 'true',
  FALSE: 'false',
  NULL: 'null',
}
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const WORD_CHAR = /[A-Za-z0-9_$.+\-]/

/**
 * Text that is nearly JSON, made into JSON.
 *
 * A single pass over the characters rather than a chain of regexes, because nearly every repair
 * depends on knowing whether the cursor is inside a string -- a regex that "removes trailing commas"
 * also rewrites `"a, }"` inside a value.
 *
 * @returns `{ok: true, value, fixes}` or `{ok: false, error, fixes}`. `fixes` is a list of sentences,
 *   one per kind of repair, for the editor to show.
 */
export function repairJson(input) {
  let text = String(input ?? '')
  if (!text.trim()) return { ok: false, error: 'The payload is empty.', fixes: [] }

  try {
    return { ok: true, value: JSON.parse(text), fixes: [] }
  } catch {
    /* Fall through to the repair. */
  }

  const fixes = new Set()

  /* A call pasted with its function around it, `analytics.identify({...});`. */
  const call = /^\s*[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text)
  if (call) {
    text = call[1]
    fixes.add('Removed the function call around the payload.')
  }
  /* Fields with no braces at all, which is how people write a payload from memory. */
  if (!/^\s*[{[]/.test(text) && /^\s*["']?[A-Za-z_$][\w$-]*["']?\s*[:=]/.test(text)) {
    text = `{${text}}`
    fixes.add('Wrapped the fields in { }.')
  }
  const out = []
  const stack = []
  /* What was emitted last, ignoring whitespace: decides whether a comma is missing or doubled. */
  let last = null
  let i = 0

  const emitWhitespace = (chunk) => out.push(chunk)
  const dropTrailingComma = () => {
    for (let at = out.length - 1; at >= 0; at -= 1) {
      if (/^\s*$/.test(out[at])) continue
      if (out[at] === ',') {
        out.splice(at, 1)
        fixes.add('Removed a trailing comma.')
      }
      return
    }
  }
  const beforeValue = () => {
    if (stack.length && (last === 'value' || last === 'close')) {
      out.push(',')
      fixes.add('Added a missing comma between fields.')
    }
  }

  const readQuoted = (quote) => {
    /* Starts on the opening quote; returns the JSON string including its quotes. */
    let body = ''
    i += 1
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        /* `\'` means nothing in JSON; inside what is now a double-quoted string it is just `'`. */
        if (next === "'" && quote === "'") body += "'"
        else body += ch + next
        i += 2
        continue
      }
      if (ch === quote) {
        i += 1
        return `"${body}"`
      }
      if (ch === '"' && quote !== '"') body += '\\"'
      else if (ch === '\n') {
        body += '\\n'
        fixes.add('Escaped a line break inside a string.')
      } else if (ch === '\t') body += '\\t'
      else body += ch
      i += 1
    }
    fixes.add('Closed an unterminated string.')
    return `"${body}"`
  }

  const peekNonSpace = (from) => {
    let at = from
    while (at < text.length && /\s/.test(text[at])) at += 1
    return text[at]
  }

  while (i < text.length) {
    const ch = text[i]

    if (/\s/.test(ch)) {
      let end = i
      while (end < text.length && /\s/.test(text[end])) end += 1
      emitWhitespace(text.slice(i, end))
      i = end
      continue
    }

    /* Comments: JSON has none, and an example copied out of documentation often does. */
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      fixes.add('Removed comments.')
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      fixes.add('Removed comments.')
      continue
    }

    if (ch === '{' || ch === '[') {
      beforeValue()
      stack.push(ch === '{' ? '}' : ']')
      out.push(ch)
      last = 'open'
      i += 1
      continue
    }

    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) {
        /* A closer for something that is not open. Dropping it is the only reading that does not
           invent structure the author did not write. */
        fixes.add(`Removed a stray “${ch}”.`)
        i += 1
        continue
      }
      if (last === 'colon') {
        out.push('null')
        fixes.add('Gave a field with no value the value null.')
      }
      dropTrailingComma()
      stack.pop()
      out.push(ch)
      last = 'close'
      i += 1
      continue
    }

    if (ch === ',') {
      if (last === 'comma' || last === 'open' || last === null) {
        fixes.add('Removed an extra comma.')
      } else {
        out.push(',')
        last = 'comma'
      }
      i += 1
      continue
    }

    if (ch === ':' || ch === '=') {
      if (ch === '=') fixes.add('Replaced “=” with “:”.')
      out.push(':')
      last = 'colon'
      i += text[i + 1] === '>' && ch === '=' ? 2 : 1
      continue
    }

    if (ch === '"' || ch === "'" || ch === '“' || ch === '”' || ch === '‘' || ch === '’') {
      const quote = ch === '“' || ch === '”' ? '”' : ch === '‘' || ch === '’' ? '’' : ch
      if (quote !== '"') fixes.add(quote === "'" ? 'Changed single quotes to double quotes.' : 'Replaced curly quotes.')
      if (quote === '”' || quote === '’') {
        /* Curly quotes open with one character and close with another, so read to either. */
        let end = i + 1
        while (end < text.length && !'”“’‘'.includes(text[end]) && text[end] !== '\n') end += 1
        if (last !== 'colon') beforeValue()
        out.push(JSON.stringify(text.slice(i + 1, end)))
        i = end < text.length && text[end] !== '\n' ? end + 1 : end
      } else {
        if (last !== 'colon') beforeValue()
        out.push(readQuoted(quote))
      }
      last = 'value'
      continue
    }

    if (WORD_CHAR.test(ch)) {
      let end = i
      while (end < text.length && WORD_CHAR.test(text[end])) end += 1
      const word = text.slice(i, end)
      const isKey = peekNonSpace(end) === ':' && stack[stack.length - 1] === '}' && last !== 'colon'

      if (last !== 'colon') beforeValue()

      if (isKey) {
        out.push(JSON.stringify(word))
        fixes.add('Quoted unquoted keys.')
        i = end
      } else if (LITERALS[word] || NUMBER.test(word)) {
        out.push(word)
        i = end
      } else if (FOREIGN_LITERALS[word]) {
        out.push(FOREIGN_LITERALS[word])
        fixes.add(`Changed ${word} to ${FOREIGN_LITERALS[word]}.`)
        i = end
      } else {
        /* A bare value. Read to the end of the field rather than the end of the word, so
           `event: Order Completed` becomes one string and not two. */
        let stop = end
        while (stop < text.length && !',}]\n'.includes(text[stop])) stop += 1
        out.push(JSON.stringify(text.slice(i, stop).trim()))
        fixes.add('Quoted unquoted text values.')
        i = stop
      }
      last = 'value'
      continue
    }

    /* Anything else -- a semicolon, a stray backtick -- is not part of any reading of the value. */
    fixes.add(`Removed a stray “${ch}”.`)
    i += 1
  }

  if (last === 'colon') {
    out.push('null')
    fixes.add('Gave a field with no value the value null.')
  }
  if (stack.length) {
    dropTrailingComma()
    out.push(...[...stack].reverse())
    fixes.add(`Closed ${stack.length} unclosed bracket${stack.length === 1 ? '' : 's'}.`)
  } else if (last === 'comma') {
    dropTrailingComma()
  }

  const repaired = out.join('')
  try {
    return { ok: true, value: JSON.parse(repaired), fixes: [...fixes] }
  } catch (error) {
    return {
      ok: false,
      error: `This could not be read as JSON even after correcting it: ${error.message}`,
      fixes: [...fixes],
    }
  }
}

/* --- making it a valid Segment call ---------------------------------------- */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/* The object slots each call carries, by Spec. A string where one of these belongs would make every
   filter that reads `properties.x` silently see nothing. */
const OBJECT_SLOTS = ['properties', 'traits', 'context', 'integrations']

/**
 * A parsed value made into a call the walkthrough can run, with every change said out loud.
 *
 * Only the fields the Spec makes *required* are filled in, and `type` is set to the tab the editor is
 * under -- the call is being run as that type, and a payload saying otherwise would run as one thing
 * while describing itself as another. Everything else the reader typed is kept as typed.
 */
export function normalizeEvent(value, type) {
  const fixes = []
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: 'A payload has to be a JSON object — { … } — not a list or a single value.',
      fixes,
    }
  }

  const { type: given, ...rest } = value
  if (given !== type) {
    fixes.push(
      given === undefined ? `Added "type": "${type}".` : `Changed "type" from ${JSON.stringify(given)} to "${type}".`,
    )
  }
  const event = { type, ...rest }

  if (type === 'track' && (typeof event.event !== 'string' || !event.event.trim())) {
    event.event = typeof event.event === 'string' || event.event == null ? 'Untitled Event' : String(event.event)
    fixes.push(`A track call needs an event name, so "event" is now "${event.event}".`)
  }
  if (type === 'group' && event.groupId == null) {
    event.groupId = 'group_5678'
    fixes.push('A group call needs a groupId, so a sample one was added.')
  }
  if (type === 'alias' && event.previousId == null) {
    event.previousId = 'anon_abcdef123456'
    fixes.push('An alias call needs a previousId, so a sample one was added.')
  }
  if (event.userId == null && event.anonymousId == null) {
    event.anonymousId = 'anon_abcdef123456'
    fixes.push('Every call needs a userId or an anonymousId, so a sample anonymousId was added.')
  }
  for (const id of ['userId', 'anonymousId', 'groupId', 'previousId']) {
    if (typeof event[id] === 'number') {
      event[id] = String(event[id])
      fixes.push(`"${id}" is a string in the Spec, so the number was quoted.`)
    }
  }
  for (const slot of OBJECT_SLOTS) {
    if (slot in event && !isPlainObject(event[slot])) {
      fixes.push(`"${slot}" has to be an object, so ${JSON.stringify(event[slot])} was replaced with {}.`)
      event[slot] = {}
    }
  }

  return { ok: true, payload: event, fixes }
}

/**
 * Typed text to a runnable event: repaired, normalised, and pretty-printed back.
 *
 * `text` is the corrected payload, so the editor can show the reader exactly what will run.
 */
export function prepareEvent(text, type) {
  const parsed = repairJson(text)
  if (!parsed.ok) return parsed
  const normal = normalizeEvent(parsed.value, type)
  if (!normal.ok) return { ...normal, fixes: [...parsed.fixes, ...normal.fixes] }
  return {
    ok: true,
    payload: normal.payload,
    text: formatPayload(normal.payload),
    fixes: [...parsed.fixes, ...normal.fixes],
  }
}

export const formatPayload = (payload) => JSON.stringify(payload, null, 2)

/** What to call an event in a list: its own name where the call has one. */
export function suggestName(payload, type) {
  if (type === 'track' && payload?.event) return String(payload.event)
  if (type === 'page' && payload?.name) return String(payload.name)
  if (type === 'group' && payload?.traits?.name) return String(payload.traits.name)
  const who = payload?.userId ?? payload?.anonymousId
  return who ? `${type} · ${who}` : type
}

/* --- the Spec's own examples ------------------------------------------------ */

const SPEC_DOCS = {
  ecommerce: 'https://segment.com/docs/connections/spec/ecommerce/v2/',
  b2b: 'https://segment.com/docs/connections/spec/b2b-saas/',
  mobile: 'https://segment.com/docs/connections/spec/mobile/',
  video: 'https://segment.com/docs/connections/spec/video/',
  email: 'https://segment.com/docs/connections/spec/email/',
  identify: 'https://segment.com/docs/connections/spec/identify/',
  page: 'https://segment.com/docs/connections/spec/page/',
  group: 'https://segment.com/docs/connections/spec/group/',
  alias: 'https://segment.com/docs/connections/spec/alias/',
}

const PRODUCT = {
  product_id: '507f1f77bcf86cd799439011',
  sku: 'G-32',
  category: 'Games',
  name: 'Monopoly: 3rd Edition',
  brand: 'Hasbro',
  variant: '200 pieces',
  price: 18.99,
  quantity: 1,
  coupon: 'MAYDEALS',
  position: 3,
  url: 'https://www.example.com/product/path',
  image_url: 'https://www.example.com/product/path.jpg',
}

/*
 * The examples, as Segment's public spec pages give them.
 *
 * `body` is only what makes the example itself -- the event name, properties or traits. The envelope
 * (ids, timestamp, context) comes from `skeleton`, so every example runs with the same context the
 * hand-written skeleton does and a filter on `context.page.path` behaves the same across all of them.
 */
export const SPEC_EVENTS = [
  /* E-commerce v2 */
  { key: 'products-searched', type: 'track', spec: 'ecommerce', body: { event: 'Products Searched', properties: { query: 'blue roses' } } },
  {
    key: 'product-list-viewed',
    type: 'track',
    spec: 'ecommerce',
    body: {
      event: 'Product List Viewed',
      properties: { list_id: 'hot_deals_1', category: 'Deals', products: [{ ...PRODUCT, position: 1 }] },
    },
  },
  { key: 'product-viewed', type: 'track', spec: 'ecommerce', body: { event: 'Product Viewed', properties: { ...PRODUCT, currency: 'USD', value: 18.99 } } },
  { key: 'product-added', type: 'track', spec: 'ecommerce', body: { event: 'Product Added', properties: { cart_id: 'skdjsidjsdkdj29j', ...PRODUCT } } },
  { key: 'cart-viewed', type: 'track', spec: 'ecommerce', body: { event: 'Cart Viewed', properties: { cart_id: 'd92jd29jd92jd29j92d92jd', products: [PRODUCT] } } },
  {
    key: 'checkout-started',
    type: 'track',
    spec: 'ecommerce',
    body: {
      event: 'Checkout Started',
      properties: {
        order_id: '50314b8e9bcf000000000000',
        affiliation: 'Google Store',
        value: 30,
        revenue: 25,
        shipping: 3,
        tax: 2,
        discount: 2.5,
        coupon: 'hasbros',
        currency: 'USD',
        products: [PRODUCT],
      },
    },
  },
  {
    key: 'order-completed',
    type: 'track',
    spec: 'ecommerce',
    body: {
      event: 'Order Completed',
      properties: {
        checkout_id: 'fksdjfsdjfisjf9sdfjsd9f',
        order_id: '50314b8e9bcf000000000000',
        affiliation: 'Google Store',
        total: 27.5,
        subtotal: 22.5,
        revenue: 25,
        shipping: 3,
        tax: 2,
        discount: 2.5,
        coupon: 'hasbros',
        currency: 'USD',
        products: [PRODUCT],
      },
    },
  },
  {
    key: 'order-refunded',
    type: 'track',
    spec: 'ecommerce',
    body: { event: 'Order Refunded', properties: { order_id: '50314b8e9bcf000000000000', total: 30, currency: 'USD', products: [PRODUCT] } },
  },
  {
    key: 'coupon-applied',
    type: 'track',
    spec: 'ecommerce',
    body: {
      event: 'Coupon Applied',
      properties: { order_id: '50314b8e9bcf000000000000', cart_id: '923923929jd29jd92dj9j93fj3', coupon_id: 'may_deals_2016', coupon_name: 'May Deals 2016', discount: 23.32 },
    },
  },
  /* B2B SaaS */
  { key: 'signed-up', type: 'track', spec: 'b2b', body: { event: 'Signed Up', properties: { type: 'organic', first_name: 'Peter', last_name: 'Gibbons', email: 'pgibbons@example.com', phone: '410-555-9412', username: 'pgibbons', title: 'Mr' } } },
  { key: 'signed-in', type: 'track', spec: 'b2b', body: { event: 'Signed In', properties: { username: 'pgibbons' } } },
  { key: 'signed-out', type: 'track', spec: 'b2b', body: { event: 'Signed Out', properties: { username: 'pgibbons' } } },
  { key: 'account-created', type: 'track', spec: 'b2b', body: { event: 'Account Created', context: { groupId: 'group_5678' }, properties: { account_name: 'Initech' } } },
  {
    key: 'trial-started',
    type: 'track',
    spec: 'b2b',
    body: { event: 'Trial Started', properties: { trial_start_date: '2026-01-15T00:00:00.000Z', trial_end_date: '2026-02-15T00:00:00.000Z', trial_plan_name: 'Business' } },
  },
  { key: 'invite-sent', type: 'track', spec: 'b2b', body: { event: 'Invite Sent', properties: { invitee_email: 'pgibbons@example.com', invitee_first_name: 'Peter', invitee_last_name: 'Gibbons', invitee_role: 'Owner' } } },
  /* Mobile */
  { key: 'application-installed', type: 'track', spec: 'mobile', body: { event: 'Application Installed', properties: { version: '1.1.2', build: '1234' } } },
  {
    key: 'application-opened',
    type: 'track',
    spec: 'mobile',
    body: { event: 'Application Opened', properties: { from_background: false, referring_application: 'GMail', url: 'url://location', version: '1.1.2', build: '1234' } },
  },
  /* Video */
  {
    key: 'video-playback-started',
    type: 'track',
    spec: 'video',
    body: {
      event: 'Video Playback Started',
      properties: {
        session_id: '12345',
        content_asset_ids: ['0129370'],
        ad_asset_ids: ['ad123', 'ad097'],
        position: 0,
        total_length: 392,
        bitrate: 100,
        framerate: 29.00002,
        video_player: 'youtube',
        sound: 55,
        full_screen: false,
        ad_enabled: false,
        quality: 'hd1080',
        livestream: false,
      },
    },
  },
  /* Email */
  {
    key: 'email-opened',
    type: 'track',
    spec: 'email',
    body: { event: 'Email Opened', properties: { email_id: '18vzF7u6au-ftcWj2tV2', email_subject: 'Welcome to Initech', campaign_id: '123', campaign_name: 'New Customer Welcome', list_id: 'newsletter' } },
  },

  /* Identify */
  {
    key: 'identify-example',
    type: 'identify',
    spec: 'identify',
    label: 'Identify with traits',
    body: {
      userId: '97980cfea0067',
      traits: {
        name: 'Peter Gibbons',
        email: 'peter@example.com',
        plan: 'premium',
        logins: 5,
        address: { street: '6th St', city: 'San Francisco', state: 'CA', postalCode: '94103', country: 'USA' },
      },
    },
  },
  {
    key: 'identify-reserved',
    type: 'identify',
    spec: 'identify',
    label: 'Identify with reserved traits',
    body: {
      userId: '97980cfea0067',
      traits: {
        firstName: 'Peter',
        lastName: 'Gibbons',
        email: 'peter@example.com',
        phone: '555-555-5555',
        title: 'Software Engineer',
        company: { name: 'Initech', id: '0e8c78ea9d97a7b8185e8632', industry: 'Technology', employee_count: 329, plan: 'enterprise' },
        createdAt: '2026-01-15T10:30:00.000Z',
      },
    },
  },
  {
    key: 'identify-anonymous',
    type: 'identify',
    spec: 'identify',
    label: 'Anonymous identify',
    body: { userId: null, traits: { email: 'peter@example.com', newsletter: true } },
  },

  /* Page */
  {
    key: 'page-home',
    type: 'page',
    spec: 'page',
    label: 'Home',
    body: { name: 'Home', properties: { title: 'Welcome | Initech', url: 'http://www.example.com', path: '/', referrer: 'https://www.google.com' } },
  },
  {
    key: 'page-category',
    type: 'page',
    spec: 'page',
    label: 'Docs · Track Spec',
    body: {
      category: 'Docs',
      name: 'Track Spec',
      properties: { title: 'Track Spec | Segment', url: 'https://segment.com/docs/connections/spec/track/', path: '/docs/connections/spec/track/' },
    },
  },

  /* Group */
  {
    key: 'group-example',
    type: 'group',
    spec: 'group',
    label: 'Initech',
    body: {
      groupId: '0e8c78ea9d97a7b8185e8632',
      traits: { name: 'Initech', industry: 'Technology', employees: 329, plan: 'enterprise', 'total billed': 830 },
    },
  },

  /* Alias */
  {
    key: 'alias-example',
    type: 'alias',
    spec: 'alias',
    label: 'Anonymous to known user',
    body: { previousId: '39239-239239-239239-23923', userId: '507f191e81034a8d' },
  },
  {
    key: 'alias-email',
    type: 'alias',
    spec: 'alias',
    label: 'Email to user id',
    body: { previousId: 'peter@example.com', userId: '507f191e81034a8d' },
  },
]

export const SPEC_LABELS = {
  ecommerce: 'E-commerce',
  b2b: 'B2B SaaS',
  mobile: 'Mobile',
  video: 'Video',
  email: 'Email',
  identify: 'Identify spec',
  page: 'Page spec',
  group: 'Group spec',
  alias: 'Alias spec',
}

export const specDocsUrl = (spec) => SPEC_DOCS[spec] ?? 'https://segment.com/docs/connections/spec/'

export const specEventsFor = (type) => SPEC_EVENTS.filter((entry) => entry.type === type)

export const specLabel = (entry) => entry.label ?? entry.body.event ?? entry.key

/** One example as a full call: the skeleton's envelope with the example's own body over it. */
export function specPayload(entry) {
  const base = skeleton(entry.type)
  for (const field of ['event', 'name', 'properties', 'traits', 'groupId', 'previousId']) delete base[field]
  const body = structuredClone(entry.body)
  /* A `context` in the example adds to the shared one rather than replacing it. */
  const context = body.context ? { ...base.context, ...body.context } : base.context
  delete body.context
  const payload = { ...base, ...body, context }
  /* The anonymous example states its `userId: null`; the Spec says to leave it out instead. */
  if (payload.userId === null) delete payload.userId
  return payload
}

/* --- saved events ----------------------------------------------------------- */

/*
 * The reader's own list, per event type: `{[type]: [{id, name, payload, spec?}]}`.
 *
 * In the browser rather than the diagram. A saved event is a fixture someone reaches for across every
 * diagram they draw -- "my Order Completed with the weird currency" -- not a fact about one
 * architecture, which is what paths (stored in the document) are. `spec` marks an entry added from the
 * examples dropdown, so the dropdown can show it ticked and untick it.
 */
export const SAVED_EVENTS = preference('saved-events', {})

/* What is in each editor, so switching palette tabs or reloading does not lose a half-written payload. */
export const EVENT_DRAFTS = preference('event-drafts', {})

export function savedFor(saved, type) {
  return Array.isArray(saved?.[type]) ? saved[type] : []
}

export function withSaved(saved, type, entry) {
  return { ...(saved ?? {}), [type]: [...savedFor(saved, type), entry] }
}

export function withoutSaved(saved, type, id) {
  return { ...(saved ?? {}), [type]: savedFor(saved, type).filter((entry) => entry.id !== id) }
}

/** Ticks or unticks one example in a type's saved list. */
export function toggleSpec(saved, entry) {
  const list = savedFor(saved, entry.type)
  const id = `spec:${entry.key}`
  if (list.some((item) => item.id === id)) return withoutSaved(saved, entry.type, id)
  return withSaved(saved, entry.type, { id, spec: entry.key, name: specLabel(entry), payload: specPayload(entry) })
}

export { EVENT_TYPES }

/* --- identity resolution fields --------------------------------------------- */

const DEFAULT_IDENTIFIERS = identityRules(null).map((rule) => rule.externalId)

/**
 * The identifiers identity resolution matches on in this diagram.
 *
 * Read from the Identity Resolution Rule components, which are the only place a diagram records them
 * -- Segment has no API for these. A diagram with none drawn falls back to Segment's own defaults, and
 * says so, because those are the rules every space starts with.
 */
export function identifiersFrom(graph) {
  const found = []
  for (const node of componentNodes(graph)) {
    const data = dataOf(node)
    if (data.kind !== 'identity_setting') continue
    for (const rule of identityRules(data)) {
      const id = String(rule.externalId ?? '').trim()
      if (id && !found.includes(id)) found.push(id)
    }
  }
  return found.length ? { identifiers: found, defaults: false } : { identifiers: DEFAULT_IDENTIFIERS, defaults: true }
}

const squash = (key) => String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/* Where an identifier appears in a payload under a different name than the rule gives it. Device
   advertising ids live at `context.device.advertisingId`, not under their rule names. */
const PAYLOAD_ALIASES = {
  iosidfa: ['advertisingid'],
  androididfa: ['advertisingid'],
  phone: ['phonenumber'],
}

/**
 * A function from a payload key to the identifier it carries, or null.
 *
 * Compared with case and punctuation squashed out, so the rule's `user_id` matches the Spec's `userId`
 * and `anonymous_id` matches `anonymousId` -- they are the same identifier in two spellings.
 */
export function identityMatcher(identifiers) {
  const byKey = new Map()
  for (const identifier of identifiers ?? []) {
    const key = squash(identifier)
    if (!key) continue
    byKey.set(key, identifier)
    for (const alias of PAYLOAD_ALIASES[key] ?? []) byKey.set(alias, identifier)
  }
  return (key) => byKey.get(squash(key)) ?? null
}

/*
 * One `key: value` pair in typed text, scalar values only. Text-based rather than walking a parsed
 * object, so it still colours a payload the reader is halfway through editing and is not valid yet.
 */
const PAIR =
  /(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([A-Za-z_$][\w$.-]*))\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,{}[\]"'][^,{}[\]\n]*)/g

/**
 * Typed text cut into runs, each marked with the identifier it carries (or null).
 *
 * Every character of the input is in exactly one run, in order -- the editor draws these over the
 * textarea, and a dropped or duplicated character would put the colouring out of step with the caret.
 */
export function highlightRuns(text, match) {
  const source = String(text ?? '')
  const runs = []
  let at = 0
  for (const found of source.matchAll(PAIR)) {
    const key = found[1] ?? found[2] ?? found[3]
    const identifier = match(key)
    if (!identifier) continue
    /* A bare `key: value` inside a quoted string -- a URL's `https:` -- is not a pair. The regex scans
       left to right, so a real pair is always consumed before its value can be mistaken for one;
       the only remaining case is text inside a string whose own key did not match, caught here. */
    const before = source.slice(0, found.index)
    if (found[3] && ((before.match(/(?<!\\)"/g) ?? []).length % 2 === 1)) continue
    const pair = found[0].replace(/\s+$/, '')
    if (found.index > at) runs.push({ text: source.slice(at, found.index), identifier: null })
    runs.push({ text: pair, identifier })
    at = found.index + pair.length
  }
  if (at < source.length) runs.push({ text: source.slice(at), identifier: null })
  return runs
}
