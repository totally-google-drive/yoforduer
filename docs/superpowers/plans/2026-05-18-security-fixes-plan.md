# Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 security vulnerabilities: XSS in player names, XSS in guestbook, rate limiting on guestbook POST, and secure visits counter

**Architecture:** Add in-memory rate limiter using Map keyed by IP+endpoint. Add escapeHtml helper in both server and client. Convert visits to server-side middleware tracking per-IP daily limits.

**Tech Stack:** Native JavaScript (no external dependencies), Express.js

---

### Task 1: Add escapeHtml helper to server.js

**Files:**
- Modify: `server.js:1-10` (add after imports)

- [ ] **Step 1: Add escapeHtml function after the imports (after line 6)**

```javascript
// Helper function to escape HTML entities
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add escapeHtml helper function"
```

---

### Task 2: Add rate limiting to guestbook POST

**Files:**
- Modify: `server.js` (add rate limiter map and middleware)

- [ ] **Step 1: Add rate limiter map after line 31 (after file initialization)**

```javascript
// Rate limiting storage
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (now > value.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 300000);
```

- [ ] **Step 2: Add rate limiting check function after the rate limiter map**

```javascript
// Check if IP has exceeded rate limit
function checkRateLimit(ip, endpoint, maxRequests, windowMs) {
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remainingTime: Math.ceil((entry.resetTime - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}
```

- [ ] **Step 3: Add rate limit check to POST /api/guestbook (around line 111)**

In the `app.post('/api/guestbook', ...)` handler, add this as the first thing inside the try block (after line 112):

```javascript
  // Check rate limit
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp, 'guestbook', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
  }
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add rate limiting to guestbook endpoint"
```

---

### Task 3: Add XSS escaping to guestbook POST

**Files:**
- Modify: `server.js:121-126` (escape name and message before storing)

- [ ] **Step 1: Update the newEntry creation to use escapeHtml**

Find lines 121-126 in server.js:
```javascript
    const newEntry = {
      id: Date.now().toString(),
      name: name.trim(),
      message: message.trim(),
      timestamp: new Date().toISOString()
    };
```

Replace with:
```javascript
    const newEntry = {
      id: Date.now().toString(),
      name: escapeHtml(name.trim()),
      message: escapeHtml(message.trim()),
      timestamp: new Date().toISOString()
    };
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: escape HTML in guestbook submissions"
```

---

### Task 4: Convert visits counter to server-side middleware

**Files:**
- Modify: `server.js` (remove POST endpoint, add middleware)

- [ ] **Step 1: Add visits tracking map after rate limiter map**

```javascript
// Visits tracking (3 per day per IP)
const visitsMap = new Map();
const VISITS_PER_DAY = 3;
const VISITS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Clean up expired visits entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of visitsMap.entries()) {
    if (now > entry.resetTime) {
      visitsMap.delete(ip);
    }
  }
}, 3600000);
```

- [ ] **Step 2: Add visits middleware function after the visits map**

```javascript
// Track visits for an IP
function trackVisit(ip) {
  const key = ip;
  const now = Date.now();
  const entry = visitsMap.get(key);

  if (!entry || now > entry.resetTime) {
    visitsMap.set(key, { count: 1, resetTime: now + VISITS_WINDOW_MS });
    return { counted: true, count: 1 };
  }

  if (entry.count >= VISITS_PER_DAY) {
    return { counted: false, count: entry.count };
  }

  entry.count++;
  return { counted: true, count: entry.count };
}
```

- [ ] **Step 3: Replace the POST /api/visits endpoint with middleware**

Find the entire `app.post('/api/visits', ...)` block (lines 148-157) and replace it with middleware that tracks visits on every request:

Add this AFTER the `app.use(express.static(...))` line (around line 53) but BEFORE the routes:

```javascript
// Middleware to track visits
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/gallery') {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    trackVisit(clientIp);
  }
  next();
});
```

Then DELETE the entire `app.post('/api/visits', ...)` block (lines 148-157).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: convert visits to server-side tracking with daily limit"
```

---

### Task 5: Add escapeHtml to client-side JS for player names

**Files:**
- Modify: `public/js.js` (add escapeHtml, apply to player names)

- [ ] **Step 1: Add escapeHtml function at the top of the file (after line 1)**

```javascript
// Escape HTML entities to prevent XSS
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: Update the player name rendering to use escapeHtml**

Find lines 45-47 in js.js:
```javascript
return '<div class="mc-tooltip-player">' + (p.name || 'Unknown') + '</div>';
```

Replace with:
```javascript
return '<div class="mc-tooltip-player">' + escapeHtml(p.name || 'Unknown') + '</div>';
```

- [ ] **Step 3: Commit**

```bash
git add public/js.js
git commit -m "feat: escape HTML in player names to prevent XSS"
```

---

### Task 6: Final verification

**Files:**
- Modify: none

- [ ] **Step 1: Verify all changes compile correctly**

Run: `node -c server.js`
Expected: No output (valid syntax)

- [ ] **Step 2: Verify the server starts**

Run: `node server.js &`
Expected: Server starts without errors

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "chore: security fixes complete - XSS protection, rate limiting, visits tracking"
```