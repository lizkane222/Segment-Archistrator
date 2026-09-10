/*
 * Links: the docs page for this kind, and the component in the customer's own
 * workspace.
 *
 * Both URLs are resolved server-side in apps/segmentapi/deeplinks.py and arrive on
 * the node, so this tab renders them rather than composing them. That is
 * deliberate: only one workspace URL shape is corroborated
 * (/{slug}/sources/{source_slug}) and the rest are best guesses, so they are kept
 * in one file on the server where correcting one is a one-line edit.
 *
 * The unverified ones are labelled as such here. A link that silently 404s teaches
 * nothing; a link that says "this pattern is a guess" tells you exactly what to
 * check and where the fix goes.
 */

import { BookOpen, CircleCheck, CircleHelp, ExternalLink, Link2Off } from 'lucide-react'

import CopyButton from '../ui/CopyButton.jsx'
import { EmptyNote, Section } from './primitives.jsx'

export default function LinksTab({ node }) {
  const data = node.data

  return (
    <>
      <Section title="Segment documentation">
        {data.docsUrl ? (
          <LinkCard
            icon={BookOpen}
            href={data.docsUrl}
            label={data.slug ? `${data.name} docs` : 'Reference'}
            sublabel={data.docsUrl}
            verified
          />
        ) : (
          <EmptyNote>No docs page mapped for this component kind.</EmptyNote>
        )}
      </Section>

      <Section title="Customer workspace">
        {data.bound === false ? (
          <p className="flex items-start gap-2 text-xs text-twilio-gray-60">
            <Link2Off size={13} className="mt-px shrink-0" aria-hidden="true" />
            Unbound components have nothing to link to. Bind this to a real
            component and the link appears.
          </p>
        ) : data.workspaceUrl ? (
          <>
            <LinkCard
              icon={ExternalLink}
              href={data.workspaceUrl}
              label="Open in Segment"
              sublabel={data.workspaceUrl}
              verified={data.linkVerified !== false}
            />
            {data.linkVerified === false && (
              <EmptyNote>
                This URL pattern has not been confirmed against a live workspace. If
                it lands somewhere wrong, the fix is one line in
                <span className="font-mono"> apps/segmentapi/deeplinks.py</span> — every
                template is collected there for exactly this reason.
              </EmptyNote>
            )}
          </>
        ) : (
          <EmptyNote>
            No workspace URL. The template for this kind needs a value the API did
            not return — a missing link beats one with a literal placeholder in it.
          </EmptyNote>
        )}
      </Section>

      {data.previewWebhookUrl && (
        <Section title="Function preview">
          <LinkCard
            icon={ExternalLink}
            href={data.previewWebhookUrl}
            label="Preview webhook"
            sublabel={data.previewWebhookUrl}
            verified
          />
        </Section>
      )}

      {data.logoUrl && (
        <Section title="Integration">
          <div className="flex items-center gap-2">
            <img
              src={data.logoUrl}
              alt=""
              className="h-6 w-6 rounded border border-twilio-gray-20 bg-white object-contain p-0.5"
            />
            <span className="min-w-0 truncate text-xs text-twilio-gray-60">{data.slug}</span>
          </div>
        </Section>
      )}
    </>
  )
}

function LinkCard({ icon: Icon, href, label, sublabel, verified }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-twilio-gray-20 p-2">
      <Icon size={14} className="mt-px shrink-0 text-twilio-blue" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="nodrag flex items-center gap-1 text-xs font-medium text-twilio-blue hover:underline"
        >
          {label}
          {verified ? (
            <CircleCheck
              size={11}
              className="shrink-0 text-twilio-success"
              aria-hidden="true"
              title="Confirmed URL pattern"
            />
          ) : (
            <CircleHelp
              size={11}
              className="shrink-0 text-twilio-warning"
              aria-hidden="true"
              title="URL pattern not yet verified against a live workspace"
            />
          )}
        </a>
        <p className="mt-0.5 break-all font-mono text-[10px] leading-snug text-twilio-gray-60">
          {sublabel}
        </p>
      </div>
      <CopyButton text={href} label="Copy link" />
    </div>
  )
}
