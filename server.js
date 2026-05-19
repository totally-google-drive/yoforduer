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
const PORT = process.env.PORT || 3000;

// JSON body parser for guestbook
app.use(express.json());

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
  for (const [ip, entry] of visitsMap.entries()) {
    if (now > entry.resetTime) {
      visitsMap.delete(ip);
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
    return { counted: true, count: 1 };
  }

  if (entry.count >= VISITS_PER_DAY) {
    return { counted: false, count: entry.count };
  }

  entry.count++;
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
    console.log('[Emoji] Error:', error.message);
    res.status(500).json({ error: 'Could not get emoji' });
  }
});

// Middleware to track visits
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/gallery') {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    trackVisit(clientIp);
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
    console.log('[MC] Error:', error.message);
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

// Guestbook API
app.get('/api/guestbook', (req, res) => {
  try {
    const messages = JSON.parse(fs.readFileSync(GUESTBOOK_FILE, 'utf8'));
    res.json(messages.reverse().slice(0, 50)); // Return newest 50
  } catch (error) {
    console.log('[Guestbook] Error reading:', error.message);
    res.json([]);
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
    fs.writeFileSync(GUESTBOOK_FILE, JSON.stringify(messages, null, 2));

    res.json(newEntry);
  } catch (error) {
    console.log('[Guestbook] Error writing:', error.message);
    res.status(500).json({ error: 'Could not save message' });
  }
});

// Visits API
app.post('/api/visits', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const result = trackVisit(clientIp);
  res.json({ counted: result.counted, count: result.count });
});

app.get('/api/visits', (req, res) => {
  // Return total count from all tracked IPs
  let totalCount = 0;
  for (const entry of visitsMap.values()) {
    totalCount += entry.count;
  }
  res.json({ count: totalCount });
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
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
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
        console.log(`[Discord] New photo added by ${message.author.username}`);
        break;
      }
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);

  // Login to Discord
  if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN);
  } else {
    console.log('[Server] Warning: DISCORD_BOT_TOKEN not set in .env');
  }
});