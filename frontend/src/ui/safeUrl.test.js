import { describe, expect, it } from 'vitest'

import { safeHttpUrl } from './safeUrl.js'

describe('safeHttpUrl', () => {
  it.each([
    'https://app.segment.com/acme/sources/web',
    'http://localhost:5177/x',
    '  https://www.twilio.com/docs/segment  ',
  ])('lets %s through', (url) => {
    expect(safeHttpUrl(url)).toMatch(/^https?:\/\//)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(document.cookie)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
    '/relative',
    'not a url',
    '',
    '   ',
    null,
    undefined,
    42,
    { href: 'https://example.com' },
  ])('refuses %j', (value) => {
    expect(safeHttpUrl(value)).toBeNull()
  })
})
