// poll.mjs
// Runs on GitHub Actions (not Google Apps Script) so it isn't affected by
// the Cloudflare block that Google's IP ranges sometimes hit on Discord's
// API. Fetches recent messages from the target channel, and for every
// image attachment found, forwards it to the Google Apps Script Web App,
// which does the actual Gemini extraction + Sheet update. The Apps Script
// side de-duplicates by (messageId, imageUrl), so it's safe if this script
// re-sends the same image on a later run.

const DISCORD_BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
const DISCORD_CHANNEL_ID = (process.env.DISCORD_CHANNEL_ID || '').trim();
const GAS_WEBAPP_URL = (process.env.GAS_WEBAPP_URL || '').trim();
const INGEST_SECRET = (process.env.INGEST_SECRET || '').trim();

// TEMPORARY DEBUG - remove once the issue is fixed. Does not print the
// actual secret values, only their lengths, so it's safe to share in logs.
console.log('[debug] DISCORD_CHANNEL_ID length:', DISCORD_CHANNEL_ID.length);
console.log('[debug] DISCORD_CHANNEL_ID is all digits:', /^\d+$/.test(DISCORD_CHANNEL_ID));
console.log('[debug] DISCORD_BOT_TOKEN length:', DISCORD_BOT_TOKEN.length);

async function debugListGuildsAndChannels() {
  console.log('[debug] --- Listing servers/channels the bot can actually see ---');
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': 'DiscordBot (https://github.com, 1.0) MailTrackerPoller/1.0',
    },
  });
  if (!guildsRes.ok) {
    console.log('[debug] Could not list guilds:', guildsRes.status, await guildsRes.text());
    return;
  }
  const guilds = await guildsRes.json();
  console.log(`[debug] Bot is in ${guilds.length} server(s):`);
  for (const guild of guilds) {
    console.log(`[debug]   Server: "${guild.name}" (id: ${guild.id})`);
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'User-Agent': 'DiscordBot (https://github.com, 1.0) MailTrackerPoller/1.0',
      },
    });
    if (!chRes.ok) {
      console.log('[debug]     Could not list channels:', chRes.status, await chRes.text());
      continue;
    }
    const channels = await chRes.json();
    channels
      .filter((c) => c.type === 0) // text channels only
      .forEach((c) => {
        const marker = c.id === DISCORD_CHANNEL_ID ? '  <-- MATCHES your DISCORD_CHANNEL_ID' : '';
        console.log(`[debug]     #${c.name}  (id: ${c.id})${marker}`);
      });
  }
  console.log('[debug] --- End of list ---');
}

await debugListGuildsAndChannels();

function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable / secret: ${name}`);
    process.exit(1);
  }
}

assertEnv('DISCORD_BOT_TOKEN', DISCORD_BOT_TOKEN);
assertEnv('DISCORD_CHANNEL_ID', DISCORD_CHANNEL_ID);
assertEnv('GAS_WEBAPP_URL', GAS_WEBAPP_URL);
assertEnv('INGEST_SECRET', INGEST_SECRET);

function isImageAttachment(att) {
  if (att.content_type && att.content_type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp)$/i.test(att.filename || '');
}

async function main() {
  const url = `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages?limit=50`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': 'DiscordBot (https://github.com, 1.0) MailTrackerPoller/1.0',
    },
  });

  if (!res.ok) {
    console.error('Discord API error:', res.status, await res.text());
    process.exit(1);
  }

  const messages = await res.json();
  console.log(`Fetched ${messages.length} recent messages from the channel.`);

  let sent = 0;
  let skipped = 0;
  let ignoredOld = 0;

  // Set the maximum age for a message to be processed (e.g., 2 hours)
  const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
  const now = Date.now();

  for (const msg of messages) {
    // --- TIME FILTER LOGIC ---
    const msgTime = new Date(msg.timestamp).getTime();
    if ((now - msgTime) > MAX_AGE_MS) {
      ignoredOld++;
      continue; // Skip this message completely if it is older than 2 hours
    }
    // -------------------------

    if (!msg.attachments || msg.attachments.length === 0) continue;

    for (const att of msg.attachments) {
      if (!isImageAttachment(att)) continue;

      const payload = {
        secret: INGEST_SECRET,
        messageId: msg.id,
        imageUrl: att.url,
        timestamp: msg.timestamp,
        label: (msg.content || '').trim(), // e.g. "3" - the update number you type alongside the screenshot
      };

      const postRes = await fetch(GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow', // Apps Script Web Apps respond with a redirect
      });

      const text = await postRes.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // non-JSON response, keep raw text for logging
      }

      if (parsed && parsed.skipped) {
        skipped++;
        console.log(`Message ${msg.id}: already logged, skipped.`);
      } else if (parsed && parsed.ok) {
        sent++;
        console.log(`Message ${msg.id}: sent and processed.`);
      } else {
        console.error(`Message ${msg.id}: unexpected response ->`, postRes.status, text);
      }
    }
  }

  console.log(`Done. New: ${sent}, already logged: ${skipped}, completely ignored (old): ${ignoredOld}.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
