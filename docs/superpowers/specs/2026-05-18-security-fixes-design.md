# Security Fixes Design

## Overview
Fix 4 security vulnerabilities in the yoforduer.org website: XSS in player names, XSS in guestbook, rate limiting on guestbook, and secure visits counter.

## XSS Fixes

### Player Names (public/js.js)
- Add `escapeHtml()` helper function that converts:
  - `<` → `&lt;`
  - `>` → `&gt;`
  - `&` → `&amp;`
  - `"` → `&quot;`
  - `'` → `&#39;`
- Apply to `p.name` before inserting via `innerHTML` at line 45-46

### Guestbook (server.js)
- Add same `escapeHtml()` helper server-side
- Escape `name` and `message` at lines 123-124 before storing in JSON
- Frontend receives pre-escaped content, displays safely

## Rate Limiting

### Implementation
- In-memory rate limiter using Map keyed by `ip:endoint`
- Config: 10 requests per minute per IP per endpoint
- Store: `{ count: number, resetTime: number }`
- On limit exceeded: return HTTP 429 with `{ error: 'Too many requests, try again later' }`

### Endpoints Protected
- `POST /api/guestbook` - 10 posts/minute/IP

## Visits Counter

### Change
- Remove `POST /api/visits` endpoint entirely
- Add server-side middleware on all page requests
- Track: `{ count: number, lastResetTime: number }` per IP
- Allow 3 visits per IP per day (rolling 24-hour window)
- On first page load, increment if under limit; skip if at limit

## Files Modified
1. `server.js` - Add escapeHtml, rate limiting, visits middleware
2. `public/js.js` - Add escapeHtml for player names