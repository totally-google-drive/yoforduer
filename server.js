require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, REST, Routes } = require('discord.js');
const path = require('path');
const util = require('minecraft-server-util');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'gallery.html'));
});


app.get('/api/photos', async (req, res) => {
  res.json(cachedPhotos);
});

app.get('/api/mc-status', async (req, res) => {
  try {
    const result = await util.status(CONFIG.mcServer, CONFIG.mcPort, { timeout: 5000 });
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