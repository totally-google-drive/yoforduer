require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, REST, Routes } = require('discord.js');
const path = require('path');
const util = require('minecraft-server-util');
const fs = require('fs');

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

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Simple lock for file writes (Node.js is single-threaded so this is safe)
let writeLock = false;
function acquireWriteLock() {
  if (writeLock) return false;
  writeLock = true;
  return true;
}
function releaseWriteLock() {
  writeLock = false;
}

// Atomic file write helper (prevents race conditions)
function writeFileAtomic(filePath, data) {
  if (!acquireWriteLock()) {
    throw new Error('Server busy, try again');
  }
  try {
    const tempFile = filePath + '.tmp.' + Date.now() + Math.random();
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, filePath);
  } finally {
    releaseWriteLock();
  }
}

// Read with retry (handles concurrent writes)
function readFileSafe(filePath, defaultValue) {
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      // File might be mid-write, retry
    }
  }
  return defaultValue;
}

// Server start time for "Last updated" feature
const SERVER_START_TIME = new Date();

// JSON body parser for guestbook
app.use(express.json({ limit: '100kb' }));

// Security headers (reverse proxy friendly)
app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Guestbook data file
const GUESTBOOK_FILE = path.join(__dirname, 'data', 'guestbook.json');
const VISITS_FILE = path.join(__dirname, 'data', 'visits.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize guestbook file if it doesn't exist
if (!fs.existsSync(GUESTBOOK_FILE)) {
  fs.writeFileSync(GUESTBOOK_FILE, JSON.stringify([], null, 2));
}

// Initialize visits counter if it doesn't exist
if (!fs.existsSync(VISITS_FILE)) {
  fs.writeFileSync(VISITS_FILE, JSON.stringify({ count: 0 }));
}

// Load persistent visit count
let persistentVisitCount = 0;
try {
  const data = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
  persistentVisitCount = data.count || 0;
} catch (error) {
  console.error('[Visits] Error loading count:', error.message);
}

// Function to save visit count to file (atomic)
function saveVisitCount() {
  if (!acquireWriteLock()) return;
  try {
    const tempFile = VISITS_FILE + '.tmp.' + Date.now() + Math.random();
    fs.writeFileSync(tempFile, JSON.stringify({ count: persistentVisitCount }, null, 2));
    fs.renameSync(tempFile, VISITS_FILE);
  } catch (error) {
    console.error('[Visits] Error saving count:', error.message);
  } finally {
    releaseWriteLock();
  }
}

// Like tracking storage (sessionId -> { likes: Set, expires: timestamp })
const likedMessages = new Map();
const MAX_PHOTOS = 500;
const MAX_LIKED_MESSAGES = 5000;
const MAX_RATE_LIMIT = 5000;
const MAX_VISITS = 5000;
const LIKES_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Clean up expired likedMessages entries every hour
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, data] of likedMessages.entries()) {
    if (removed >= MAX_LIKED_MESSAGES) break;
    if (now > data.expires) {
      likedMessages.delete(key);
      removed++;
    }
  }
  // Also enforce max size
  if (likedMessages.size > MAX_LIKED_MESSAGES) {
    for (const [key] of likedMessages.entries()) {
      likedMessages.delete(key);
      if (likedMessages.size <= MAX_LIKED_MESSAGES) break;
    }
  }
}, 3600000);

// Rate limiting storage
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, value] of rateLimitMap.entries()) {
    if (removed >= MAX_RATE_LIMIT) break;
    if (now > value.resetTime) {
      rateLimitMap.delete(key);
      removed++;
    }
  }
  // Also enforce max size
  if (rateLimitMap.size > MAX_RATE_LIMIT) {
    for (const [key] of rateLimitMap.entries()) {
      rateLimitMap.delete(key);
      if (rateLimitMap.size <= MAX_RATE_LIMIT) break;
    }
  }
}, 300000);

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

// Visits tracking (3 per day per IP)
const visitsMap = new Map();
const VISITS_PER_DAY = 3;
const VISITS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Clean up expired visits entries every hour
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [ip, entry] of visitsMap.entries()) {
    if (removed >= MAX_VISITS) break;
    if (now > entry.resetTime) {
      visitsMap.delete(ip);
      removed++;
    }
  }
  // Also enforce max size
  if (visitsMap.size > MAX_VISITS) {
    for (const [ip] of visitsMap.entries()) {
      visitsMap.delete(ip);
      if (visitsMap.size <= MAX_VISITS) break;
    }
  }
}, 3600000);

// Track visits for an IP
function trackVisit(ip) {
  const key = ip;
  const now = Date.now();
  const entry = visitsMap.get(key);

  if (!entry || now > entry.resetTime) {
    visitsMap.set(key, { count: 1, resetTime: now + VISITS_WINDOW_MS });
    // Increment persistent count
    persistentVisitCount++;
    saveVisitCount();
    return { counted: true, count: 1 };
  }

  if (entry.count >= VISITS_PER_DAY) {
    return { counted: false, count: entry.count };
  }

  entry.count++;
  // Increment persistent count
  persistentVisitCount++;
  saveVisitCount();
  return { counted: true, count: entry.count };
}

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CONFIG = {
  guildId: process.env.DISCORD_GUILD_ID,
  channelId: process.env.DISCORD_CHANNEL_ID,
  scanIntervalMs: 60000, // 1 minute
  mcServer: process.env.MC_SERVER || 'yoforduer.org',
  mcPort: parseInt(process.env.MC_PORT) || 25565
};

// Store cached photos
let cachedPhotos = [];

app.use(express.static(path.join(__dirname, 'public')));

// Server info API (for "Last updated" feature)
app.get('/api/server-info', (req, res) => {
  res.json({
    startTime: SERVER_START_TIME.toISOString(),
    uptime: Math.floor((Date.now() - SERVER_START_TIME.getTime()) / 1000)
  });
});

// Random emoji favicon API
const EMOJIS_DIR = path.join(__dirname, 'public', 'emojis');

app.get('/api/random-emoji', (req, res) => {
  try {
    const files = fs.readdirSync(EMOJIS_DIR).filter(f => f.endsWith('.svg'));
    if (files.length === 0) {
      return res.status(404).json({ error: 'No emojis found' });
    }
    const randomFile = files[Math.floor(Math.random() * files.length)];
    res.json({ emoji: `/emojis/${randomFile}` });
  } catch (error) {
    console.error('[Emoji] Error:', error.message);
    res.status(500).json({ error: 'Could not get emoji' });
  }
});

// Middleware to track visits
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/gallery') {
    try {
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      trackVisit(clientIp);
    } catch (e) {
      // Don't fail request if tracking fails
    }
  }
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'gallery.html'));
});

app.get('/guestbook', (req, res) => {
  res.sendFile(path.join(__dirname, 'guestbook.html'));
});


app.get('/api/photos', async (req, res) => {
  // Rate limit photos API: 60 requests per minute per IP
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp, 'photos', 60, RATE_LIMIT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
  }
  res.json(cachedPhotos);
});

app.get('/api/mc-status', async (req, res) => {
  try {
    const result = await util.status(CONFIG.mcServer, CONFIG.mcPort, { timeout: 10000 });
    console.log('[MC] Response:', JSON.stringify(result, null, 2));
    res.json({
      online: true,
      version: result.version.name,
      players: result.players.online,
      maxPlayers: result.players.max,
      ping: result.roundTripLatency || 0,
      motd: result.motd?.clean || 'A Minecraft Server',
      favicon: result.favicon || null,
      samplePlayers: result.players.sample || []
    });
  } catch (error) {
    console.error('[MC] Error:', error.message);
    res.json({
      online: false,
      players: 0,
      maxPlayers: 0,
      ping: 0,
      version: null,
      motd: null,
      samplePlayers: []
    });
  }
});

// Guestbook API with pagination and search
app.get('/api/guestbook', (req, res) => {
  try {
    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));

    // Get params with bounds validation
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const search = req.query.search || '';

    // Get session ID (same logic as like endpoint)
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const sessionId = req.headers['x-session-id'] || clientIp;
    const sessionData = likedMessages.get(sessionId);
    const sessionLikes = sessionData ? sessionData.likes : null;

    // Filter by search query (case-insensitive)
    let filtered = messages;
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = messages.filter(msg =>
        msg.name.toLowerCase().includes(searchLower) ||
        msg.message.toLowerCase().includes(searchLower)
      );
    }

    // Get total count (before pagination)
    const total = filtered.length;

    // Calculate pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    // Build a map for quick parent lookups
    const parentMap = {};
    filtered.forEach(msg => { parentMap[msg.id] = msg.name; });
    const paginatedMessages = filtered.slice(startIndex, endIndex).reverse().map(msg => ({
      ...msg,
      parentName: msg.parentId ? parentMap[msg.parentId] : null,
      liked: sessionLikes ? sessionLikes.has(msg.id) : false
    }));

    // Return result
    res.json({
      messages: paginatedMessages,
      total: total,
      page: page,
      hasMore: endIndex < total
    });
  } catch (error) {
    console.error('[Guestbook] Error reading:', error.message);
    res.json({ messages: [], total: 0, page: 1, hasMore: false });
  }
});

// Reply to a guestbook message
app.post('/api/guestbook/:id/reply', (req, res) => {
  try {
    // Check rate limit
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(clientIp, 'guestbook', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
    }

    const parentId = req.params.id;
    const { name, message } = req.body;

    // Enhanced input validation
    if (!name || !message || typeof name !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const trimmedName = name.trim();
    const trimmedMessage = message.trim();

    // Strict length limits with trimming
    if (trimmedName.length === 0 || trimmedName.length > 50 || trimmedMessage.length === 0 || trimmedMessage.length > 500) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // Block common XSS/HTML injection patterns (same as main post)
    const dangerousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /data:/i,
      /vbscript:/i,
      /expression\s*\(/i,
      /<\s*iframe/i,
      /<\s*object/i,
      /<\s*embed/i,
      /<\s*link/i,
      /<\s*style/i,
      /\$\{/,
      /\$\(/,
      /\{user\.|\{client\./
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedName) || pattern.test(trimmedMessage)) {
        console.log('[Guestbook] Blocked suspicious input:', pattern);
        return res.status(400).json({ error: 'Invalid input' });
      }
    }

    // Block URLs in messages
    const urlPattern = /https?:\/\/[^\s]+/i;
    if (urlPattern.test(trimmedMessage)) {
      return res.status(400).json({ error: 'No URLs allowed' });
    }

    // Block excessive whitespace/blocking characters
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmedName) || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmedMessage)) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));

    // Verify parent message exists
    const parentMessage = messages.find(m => m.id === parentId);
    if (!parentMessage) {
      return res.status(404).json({ error: 'Parent message not found' });
    }

    // Create reply entry
    const newEntry = {
      id: Buffer.from(Date.now().toString() + Math.random().toString(36)).toString('base64'),
      parentId: parentId,
      name: escapeHtml(trimmedName).slice(0, 50),
      message: escapeHtml(trimmedMessage).slice(0, 500),
      timestamp: new Date().toISOString()
    };

    messages.push(newEntry);
    writeFileAtomic(GUESTBOOK_FILE, messages);

    res.json(newEntry);
  } catch (error) {
    console.error('[Guestbook] Error writing reply:', error.message);
    res.status(500).json({ error: 'Could not save reply' });
  }
});

// Like a guestbook message

app.post('/api/guestbook/:id/like', (req, res) => {
  try {
    // Rate limit: 30 likes per minute per IP (softened)
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(clientIp, 'guestbook-like', 30, 60000);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many likes, try again in ${rateCheck.remainingTime} seconds` });
    }

    const messageId = req.params.id;
    const sessionId = req.headers['x-session-id'] || clientIp;

    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));

    // Find the message
    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if this session already liked this message
    if (!likedMessages.has(sessionId)) {
      likedMessages.set(sessionId, { likes: new Set(), expires: Date.now() + LIKES_EXPIRE_MS });
    } else {
      // Refresh expiration on activity
      likedMessages.get(sessionId).expires = Date.now() + LIKES_EXPIRE_MS;
    }
    const sessionData = likedMessages.get(sessionId);
    const sessionLikes = sessionData.likes;

    if (sessionLikes.has(messageId)) {
      // Unlike (remove like)
      sessionLikes.delete(messageId);
      messages[messageIndex].likes = (messages[messageIndex].likes || 1) - 1;
      if (messages[messageIndex].likes < 0) messages[messageIndex].likes = 0;
    } else {
      // Like (add like)
      sessionLikes.add(messageId);
      messages[messageIndex].likes = (messages[messageIndex].likes || 0) + 1;
    }

    writeFileAtomic(GUESTBOOK_FILE, messages);

    res.json({
      likes: messages[messageIndex].likes,
      liked: sessionLikes.has(messageId)
    });
  } catch (error) {
    console.error('[Guestbook] Error liking:', error.message);
    res.status(500).json({ error: 'Could not like message' });
  }
});

app.post('/api/guestbook', (req, res) => {
  try {
    // Check rate limit
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(clientIp, 'guestbook', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
    }

    const { name, message } = req.body;

    // Enhanced input validation
    if (!name || !message || typeof name !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const trimmedName = name.trim();
    const trimmedMessage = message.trim();

    // Strict length limits with trimming
    if (trimmedName.length === 0 || trimmedName.length > 50 || trimmedMessage.length === 0 || trimmedMessage.length > 500) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // Block common XSS/HTML injection patterns
    const dangerousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /data:/i,
      /vbscript:/i,
      /expression\s*\(/i,
      /<\s*iframe/i,
      /<\s*object/i,
      /<\s*embed/i,
      /<\s*link/i,
      /<\s*style/i,
      /\$\{/,
      /\$\(/,
      /\{user\.|\{client\./
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedName) || pattern.test(trimmedMessage)) {
        console.log('[Guestbook] Blocked suspicious input:', pattern);
        return res.status(400).json({ error: 'Invalid input' });
      }
    }

    // Block URLs in messages (prevent link spam)
    const urlPattern = /https?:\/\/[^\s]+/i;
    if (urlPattern.test(trimmedMessage)) {
      return res.status(400).json({ error: 'No URLs allowed' });
    }

    // Block excessive whitespace/blocking characters
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmedName) || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmedMessage)) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));

    // Generate a more secure unique ID
    const newEntry = {
      id: Buffer.from(Date.now().toString() + Math.random().toString(36)).toString('base64'),
      name: escapeHtml(trimmedName).slice(0, 50),
      message: escapeHtml(trimmedMessage).slice(0, 500),
      timestamp: new Date().toISOString()
    };

    messages.push(newEntry);
    writeFileAtomic(GUESTBOOK_FILE, messages);

    res.json(newEntry);
  } catch (error) {
    console.error('[Guestbook] Error writing:', error.message);
    res.status(500).json({ error: 'Could not save message' });
  }
});

// Visits API (rate limited: 10 requests per minute per IP)
app.post('/api/visits', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp, 'visits', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
  }
  const result = trackVisit(clientIp);
  res.json({ counted: result.counted, count: result.count });
});

app.get('/api/messages', (req, res) => {
  // Rate limit messages API: 60 requests per minute per IP
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp, 'messages', 60, RATE_LIMIT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many requests, try again in ${rateCheck.remainingTime} seconds` });
  }
  try {
    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));
    res.json({ count: Array.isArray(messages) ? messages.length : 0 });
  } catch (error) {
    console.error('[Messages] Error reading guestbook:', error.message);
    res.status(500).json({ error: 'Could not read guestbook' });
  }
});

app.get('/api/visits', (req, res) => {
  // Return persistent count from file
  res.json({ count: persistentVisitCount });
});


async function fetchPhotosFromChannel() {
  try {
    if (!CONFIG.guildId || !CONFIG.channelId) {
      console.log('[Discord] Missing GUILD_ID or CHANNEL_ID in .env');
      return;
    }

    const guild = await client.guilds.fetch(CONFIG.guildId);
    if (!guild) {
      console.log('[Discord] Guild not found');
      return;
    }

    const channel = await guild.channels.fetch(CONFIG.channelId);
    if (!channel) {
      console.log('[Discord] Channel not found');
      return;
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    const photos = [];

    for (const [messageId, message] of messages) {

      if (message.author.bot && message.attachments.size === 0) continue;

      for (const attachment of message.attachments.values()) {
        const ct = attachment.contentType || '';
        if (ct.startsWith('image/') || ct === 'image/gif') {
          photos.push({
            id: messageId,
            imageUrl: attachment.url,
            thumbnailUrl: attachment.url, 
            username: message.author.username,
            displayName: message.author.displayName || message.author.username,
            avatarUrl: message.author.displayAvatarURL({ format: 'png', size: 128 }),
            timestamp: message.createdAt.toISOString()
          });
        }
      }
    }

    cachedPhotos = photos;
    console.log(`[Discord] Found ${photos.length} photos in channel`);
  } catch (error) {
    console.error('[Discord] Error fetching photos:', error.message);
  }
}

// Discord client event handlers
client.on('ready', async () => {
  console.log(`[Discord] Bot logged in as ${client.user.tag}`);

  await fetchPhotosFromChannel();

  setInterval(fetchPhotosFromChannel, CONFIG.scanIntervalMs);
});

client.on('messageCreate', async (message) => {
  if (message.guildId === CONFIG.guildId &&
      message.channelId === CONFIG.channelId &&
      message.attachments.size > 0) {

    for (const attachment of message.attachments.values()) {
      if (attachment.contentType && attachment.contentType.startsWith('image/')) {
        const newPhoto = {
          id: message.id,
          imageUrl: attachment.url,
          thumbnailUrl: attachment.url,
          username: message.author.username,
          displayName: message.author.displayName || message.author.username,
          avatarUrl: message.author.displayAvatarURL({ format: 'png', size: 128 }),
          timestamp: message.createdAt.toISOString()
        };

        cachedPhotos.unshift(newPhoto);
    if (cachedPhotos.length > MAX_PHOTOS) {
      cachedPhotos = cachedPhotos.slice(0, MAX_PHOTOS);
    }
        console.log(`[Discord] New photo added by ${message.author.username}`);
        break;
      }
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log('[Server] Minecraft server set to ping: ' + CONFIG.mcServer + ':' + CONFIG.mcPort);

  // Login to Discord
  if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
      console.error('[Discord] Login failed:', err.message);
    });
  } else {
    console.log('[Server] Warning: DISCORD_BOT_TOKEN not set in .env');
  }
});