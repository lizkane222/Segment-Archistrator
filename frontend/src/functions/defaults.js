/*
 * The code a function component starts with, and how much of it may be stored.
 *
 * One default per function kind, each a trimmed version of the corresponding
 * scaffold in the Segment-Functions-Template repo -- the contract, the error classes
 * that mean something, and the handler set. What is deliberately *not* copied is the
 * seventy-line header each of those files carries: it is excellent documentation for
 * a repo you have checked out, and in a 384px sidebar it is nine screens of scrolling
 * before the first line of code. The link at the top of each default goes to the same
 * material.
 *
 * ## Every default returns the event
 *
 * Asked for directly, and it is also the only defensible starting point: a component
 * someone has just dropped on a diagram has made no decision yet, and code that
 * dropped or reshaped the event by default would make the walkthrough report a
 * transformation the user never asked for. So the defaults are pass-through, with the
 * interesting cases -- a redaction, a suppressed test event -- present and commented
 * on but arranged so that the event still comes out.
 *
 * Two of them do transform, because they are the point of their kind and both are in
 * Segment's own scaffold: a destination insert function drops `is_test` traffic and
 * redacts traits. Neither fires on the payloads ../simulation/payload.js builds, so a
 * fresh diagram still reads as pass-through until someone edits the event to trip it.
 *
 * ## The cap
 *
 * A real workspace function can be far longer than this. The cap is not a claim about
 * Segment -- it is what this *document* will carry, since the code is stored inside
 * the diagram's JSONB alongside every node position. 20,000 characters is about 500
 * lines: enough that a genuine single-destination function usually pastes in whole,
 * which is what makes the fold gutter in ./CodeEditor.jsx worth having, and bounded
 * enough that ten of them do not turn a diagram into a source tree.
 */

/** Characters of code one component may carry. See the header for why this number. */
export const MAX_CODE_LENGTH = 20000

/** The four kinds that run customer-authored JavaScript. */
export const FUNCTION_KINDS = Object.freeze([
  'source_function',
  'source_insert_function',
  'destination_insert_function',
  'destination_function',
])

export const isFunctionKind = (kind) => FUNCTION_KINDS.includes(kind)

/**
 * Which handler an event of each type is dispatched to.
 *
 * Segment's own names, so code pasted out of a workspace works untouched. `screen`
 * and `delete` are here even though ../simulation/payload.js builds neither: a pasted
 * function declares all seven, and the tester should be able to exercise the ones the
 * skeletons do not cover.
 */
export const HANDLER_FOR_TYPE = Object.freeze({
  track: 'onTrack',
  identify: 'onIdentify',
  page: 'onPage',
  screen: 'onScreen',
  group: 'onGroup',
  alias: 'onAlias',
  delete: 'onDelete',
})

/*
 * A source function is the one kind with a different shape: it takes an HTTP request
 * rather than an event, and it *emits* events instead of returning one. So it has one
 * handler, and the runner reads what it emitted rather than what it returned.
 */
export const REQUEST_HANDLER = 'onRequest'

export const handlerNames = (kind) =>
  kind === 'source_function' ? [REQUEST_HANDLER] : Object.values(HANDLER_FOR_TYPE)

/** The docs page for a kind, linked from the top of its default and from the panel. */
export const DOCS_URL = Object.freeze({
  source_function:
    'https://www.twilio.com/docs/segment/connections/functions/source-functions',
  source_insert_function:
    'https://www.twilio.com/docs/segment/connections/functions/source-insert-functions',
  destination_insert_function:
    'https://www.twilio.com/docs/segment/connections/functions/insert-functions',
  destination_function:
    'https://www.twilio.com/docs/segment/connections/functions/destination-functions',
})

/* --- the defaults ---------------------------------------------------------- */

const SOURCE = `/**
 * Source Function — turns an inbound webhook into Segment events.
 *
 * ONE handler: onRequest(request, settings). You do not return events, you emit
 * them with Segment.track(...) / Segment.identify(...) — as many as you like.
 * Every emit needs an identity (userId or anonymousId) or Segment drops it.
 *
 *   throw new InvalidEventPayload(...)  permanent reject, no retry
 *   throw new RetryError(...)           Segment retries, up to six times
 *
 * request.headers is a Headers instance — use .get('x-thing'), not ['x-thing'].
 * request.url is a URL instance — use .searchParams.get('shop').
 *
 * Keep settings inside the handler. Instances are reused between invocations, so
 * a module-scoped settings value can leak from one event to the next.
 */
async function onRequest(request, settings) {
  const body = await request.json();

  // An identity is mandatory. Bail loudly rather than emitting events that
  // Segment will silently discard.
  const userId = body.userId || body.user_id || body.id;
  const anonymousId = body.anonymousId || body.anonymous_id;

  if (!userId && !anonymousId) {
    throw new InvalidEventPayload(
      'Payload has no userId or anonymousId — Segment would drop every event emitted from it.'
    );
  }

  const identity = userId ? { userId } : { anonymousId };

  // Replace the mapping below with your own.
  if (body.traits || body.email) {
    Segment.identify({
      ...identity,
      traits: {
        ...(body.traits || {}),
        ...(body.email ? { email: body.email } : {})
      }
    });
  }

  if (body.event) {
    Segment.track({
      ...identity,
      event: body.event,
      properties: body.properties || {}
    });
  }
}
`

const SOURCE_INSERT = `/**
 * Source Insert Function — runs on every event entering the source, before it
 * fans out to anything. Use it for enrichment that has to apply everywhere.
 *
 * Each handler takes (event, settings) and MUST return an event. What you return
 * replaces the original downstream; returning nothing sends nothing on.
 *
 *   throw new DropEvent(...)     discard this event entirely
 *   throw new RetryError(...)    transient failure, Segment retries
 *
 * An OMITTED handler blocks that event type outright — it has nothing to call.
 * That is why all seven are declared here and the untouched ones pass through.
 *
 * Keep settings inside the handler: instances are reused between invocations.
 */
async function onIdentify(event, settings) {
  return event;
}

async function onTrack(event, settings) {
  // Example — stamp every event with where it was enriched. Delete or replace it.
  // event.context = { ...(event.context || {}), enriched_by: 'source-insert' };
  return event;
}

async function onGroup(event, settings) {
  return event;
}

async function onPage(event, settings) {
  return event;
}

async function onScreen(event, settings) {
  return event;
}

async function onAlias(event, settings) {
  return event;
}

async function onDelete(event, settings) {
  return event;
}
`

const DESTINATION_INSERT = `/**
 * Destination Insert Function — sits between the source and ONE destination.
 * Every event bound for that destination passes through here first, so this is
 * where a transform that is a quirk of the vendor belongs rather than a fact
 * about your data (that would be a source insert function).
 *
 * Each handler takes (event, settings) and MUST return an event.
 *
 *   throw new DropEvent(...)     suppress delivery to THIS destination only
 *   throw new RetryError(...)    transient failure, Segment retries
 *
 * An OMITTED handler blocks that event type outright.
 *
 * Mapping triggers and destination filters run BEFORE this, so you cannot use an
 * insert function to make an event match its trigger — that is already decided.
 */

// Traits this vendor must never receive. A constant is fine at module scope; it
// is not read from settings.
const REDACTED_TRAITS = ['ssn', 'password', 'creditCard', 'dateOfBirth'];

async function onTrack(event, settings) {
  // Suppress test traffic. Strict === true on purpose: the string "false" is
  // truthy, and test flags arrive as strings more often than you would like.
  if (event.properties?.is_test === true) {
    throw new DropEvent('Test event — not forwarded to the destination.');
  }

  return event;
}

async function onIdentify(event, settings) {
  // Copy rather than mutate, so the original is never half-redacted if something
  // below throws.
  const safeTraits = { ...(event.traits || {}) };
  for (const key of REDACTED_TRAITS) {
    delete safeTraits[key];
  }

  event.traits = safeTraits;
  return event;
}

async function onGroup(event, settings) {
  return event;
}

async function onPage(event, settings) {
  return event;
}

async function onScreen(event, settings) {
  return event;
}

async function onAlias(event, settings) {
  return event;
}

async function onDelete(event, settings) {
  return event;
}
`

const DESTINATION = `/**
 * Destination Function — receives events and forwards them to a third-party API.
 * It is the terminus: nothing downstream consumes what you return, and the HTTP
 * call is the point.
 *
 *   throw new RetryError(...)           transient, Segment retries with backoff
 *   throw new ValidationError(...)      bad config, no retry
 *   throw new InvalidEventPayload(...)  bad event, no retry
 *   throw new EventNotSupported(...)    this destination does not take that type
 *
 * STATUS HANDLING IS THE WHOLE JOB. Retry on 5xx and 429 only. Retrying a 400
 * loops forever on an event that can never succeed; swallowing a 503 loses data.
 *
 * Do not log secrets or PII: the Errors and Logs tabs are visible to everyone in
 * the workspace.
 *
 * Note for this simulator: it runs your handlers synchronously and has no fetch,
 * so the send() below is commented out. Uncomment it in a real function.
 */

// Turn a response into either "fine" or the right kind of thrown error.
// async function assertDeliverable(response, context) {
//   if (response.status >= 500 || response.status === 429) {
//     throw new RetryError(\`\${context} failed with \${response.status} — will retry\`);
//   }
//   if (!response.ok) {
//     throw new InvalidEventPayload(\`\${context} rejected with \${response.status}\`);
//   }
//   return response;
// }
//
// async function send(path, payload, settings) {
//   if (!settings.apiKey) throw new ValidationError('The apiKey setting is required.');
//   const url = \`\${settings.endpoint.replace(/\\/$/, '')}\${path}\`;
//   let response;
//   try {
//     response = await fetch(url, {
//       method: 'POST',
//       headers: {
//         Authorization: \`Bearer \${settings.apiKey}\`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify(payload)
//     });
//   } catch (error) {
//     throw new RetryError(\`Connection to \${url} failed: \${error.message}\`);
//   }
//   return assertDeliverable(response, \`POST \${url}\`);
// }

async function onTrack(event, settings) {
  // Audience syncs from Engage arrive as track events named "Audience Entered"
  // and "Audience Exited". On an ad platform this is the branch that matters.
  //
  // await send('/events', {
  //   event_name: event.event,
  //   user_id: event.userId,
  //   timestamp: event.timestamp,
  //   properties: event.properties || {}
  // }, settings);

  return event;
}

async function onIdentify(event, settings) {
  // await send('/profiles', { user_id: event.userId, traits: event.traits || {} }, settings);
  return event;
}

async function onGroup(event, settings) {
  return event;
}

async function onPage(event, settings) {
  return event;
}

async function onScreen(event, settings) {
  return event;
}

async function onAlias(event, settings) {
  return event;
}

async function onDelete(event, settings) {
  return event;
}
`

const DEFAULTS = Object.freeze({
  source_function: SOURCE,
  source_insert_function: SOURCE_INSERT,
  destination_insert_function: DESTINATION_INSERT,
  destination_function: DESTINATION,
})

/** The starting code for a function kind, or null for anything that is not one. */
export function defaultCode(kind) {
  return DEFAULTS[kind] ?? null
}

/** Is this node's code still exactly what it was seeded with? Decides whether "Reset" says anything. */
export function isDefaultCode(kind, code) {
  const seed = defaultCode(kind)
  if (!seed) return false
  return (code ?? '').trim() === seed.trim()
}

/**
 * The `{code}` a newly drawn function starts with, or null.
 *
 * Only for a function someone *drew*. A node bound to a real workspace function is
 * deliberately left with no code at all, and that is the most important line in this
 * file: the Public API does not return a function's body, so seeding one would be this
 * tool inventing an answer to "what does their function do" and then having the
 * walkthrough report it as fact. An absent `code` means "not known", which is what the
 * simulator said about every function before any of this existed -- see `visitFunction`
 * in ../simulation/router.js.
 *
 * Spread into a node's data, so `null` is a no-op at the call site.
 */
export function codeSeed(kind, { bound = false } = {}) {
  if (bound) return null
  const code = defaultCode(kind)
  return code ? { code } : null
}
