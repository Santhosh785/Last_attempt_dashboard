require('dotenv').config();
const express = require('express');
const path    = require('path');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Zoho Bigin helpers ───────────────────────────────────────────────────────

let zohoTokenCache = { token: null, expiresAt: 0 };

async function getZohoAccessToken() {
  if (zohoTokenCache.token && Date.now() < zohoTokenCache.expiresAt) {
    return zohoTokenCache.token;
  }
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token fetch failed: ' + JSON.stringify(data));
  zohoTokenCache = { token: data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return data.access_token;
}

function formatViewedAt() {
  return 'Last Attempt Viewed';
}

function phoneVariants(phone) {
  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : digits;
  return [
    `+91${ten}`,   // +919876543210
    `91${ten}`,    // 919876543210
    ten,           // 9876543210
  ];
}

async function searchBiginByPhone(token, phone) {
  for (const variant of phoneVariants(phone)) {
    const res = await fetch(
      `https://www.zohoapis.in/bigin/v2/Contacts/search?phone=${encodeURIComponent(variant)}&fields=id,Full_Name`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await res.json();
    if (data.data && data.data.length > 0) return data.data[0];
  }
  return null;
}

async function updateBiginPotential(phone, timestamp) {
  if (!process.env.ZOHO_CLIENT_ID) return; // Zoho not configured
  try {
    const token = await getZohoAccessToken();

    const contact = await searchBiginByPhone(token, phone);
    if (!contact) {
      console.log('[BIGIN] No contact found for phone:', phone);
      return;
    }
    const label   = formatViewedAt(timestamp);

    const updateRes = await fetch(
      `https://www.zohoapis.in/bigin/v2/Contacts/${contact.id}`,
      {
        method:  'PUT',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: [{ Potential: label }] }),
      }
    );
    const updateData = await updateRes.json();
    const status = updateData.data?.[0]?.status;
    console.log(`[BIGIN] Updated Potential for ${contact.Full_Name || phone} → "${label}" (${status})`);
  } catch (err) {
    console.error('[BIGIN] updateBiginPotential error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// In-memory lock to prevent race conditions for simultaneous requests from the same user
const phoneLocks = new Set();

app.set('trust proxy', 1);
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

const BOT_UA_PATTERN = /whatsapp|wati|bot|crawler|spider|preview|facebookexternalhit|linkedinbot|twitterbot|slackbot|telegrambot/i;

// POST /api/test — ingest a tracking event
app.post('/api/test', async (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (BOT_UA_PATTERN.test(ua)) {
    console.log('[SKIPPED] Bot/preview request detected, UA:', ua);
    return res.status(200).json({ ok: true, skipped: true });
  }
  const {
    name,
    phone,
    event_type,
    time_spent_seconds,
    scroll_depth_percent,
    scroll_count,
    refresh_count,
    shared,
    timestamp
  } = req.body;

  if (!event_type) {
    return res.status(400).json({ error: 'event_type is required' });
  }

  let formattedPhone = phone || '';
  if (formattedPhone) {
    // Keep only digits and '+'
    formattedPhone = formattedPhone.replace(/[^\d+]/g, '');
    // Strip leading zeros before formatting
    formattedPhone = formattedPhone.replace(/^\+?0+/, '');
    if (formattedPhone.length === 10) {
      formattedPhone = '+91' + formattedPhone;
    } else if (formattedPhone.startsWith('91') && formattedPhone.length === 12) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }
  }

  const event = {
    name:                 name  || '',
    phone:                formattedPhone,
    event_type,
    time_spent_seconds:   Number(time_spent_seconds)   || 0,
    scroll_depth_percent: Number(scroll_depth_percent) || 0,
    scroll_count:         Number(scroll_count)         || 0,
    refresh_count:        Number(refresh_count)        || 0,
    shared:               Boolean(shared),
    timestamp:            timestamp || new Date().toISOString(),
    received_at:          new Date().toISOString(),
  };

  console.log('[EVENT]', JSON.stringify(event));

  // Update Bigin Potential field when user opens the page
  if (event_type === 'page_open' && formattedPhone) {
    updateBiginPotential(formattedPhone, event.timestamp).catch(() => {});
  }

  // Save to Supabase if configured
  if (supabase) {
    if (formattedPhone) {
      // Wait if another request for this phone is currently processing
      while (phoneLocks.has(formattedPhone)) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      phoneLocks.add(formattedPhone);

      try {
        // Prevent duplicates by checking if phone exists
        const { data } = await supabase.from('tracking_events').select('id, event_type').eq('phone', formattedPhone).limit(1);
        if (data && data.length > 0) {
          // Don't let page_close overwrite high-priority events
          const currentType = data[0].event_type;
          const highPriority = ['rti_button_click', 'shared'];
          if (highPriority.includes(currentType) && !highPriority.includes(event.event_type)) {
            event.event_type = currentType;
          }

          const { error } = await supabase.from('tracking_events').update(event).eq('id', data[0].id);
          if (error) console.error('Supabase update error:', error.message);
          else console.log('Successfully updated existing Supabase record for', formattedPhone);
        } else {
          const { error } = await supabase.from('tracking_events').insert([event]);
          if (error) console.error('Supabase insert error:', error.message);
          else console.log('Successfully saved to Supabase');
        }
      } finally {
        phoneLocks.delete(formattedPhone);
      }
    } else {
      const { error } = await supabase.from('tracking_events').insert([event]);
      if (error) console.error('Supabase insert error:', error.message);
    }
  }

  res.status(200).json({ ok: true });
});

// GET /api/events — read and return logged events
// Query params:
//   ?limit=N        — return last N events (default 100, max 1000)
//   ?event_type=X   — filter by event_type
app.get('/api/events', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase is not configured.' });

  const limit = Math.min(Number(req.query.limit) || 1000, 1000);
  const typeFilter = req.query.event_type || null;

  let query = supabase.from('tracking_events').select('*').order('received_at', { ascending: false }).limit(limit);
  if (typeFilter) {
    query = query.eq('event_type', typeFilter);
  }
  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Deduplicate by phone number for the UI so old duplicates are hidden
  const dedupedMap = new Map();
  const events = [];
  for (const row of data) {
    if (row.phone) {
      if (!dedupedMap.has(row.phone)) {
        dedupedMap.set(row.phone, true);
        events.push(row);
      }
    } else {
      events.push(row);
    }
  }

  return res.json({ events, total: events.length, returned: events.length });
});

// GET /dashboard — serve the frontend dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// DELETE /api/events/:id — delete a specific event
app.delete('/api/events/:id', async (req, res) => {
  if (!supabase) return res.status(400).json({ error: 'Supabase not configured' });
  const { error } = await supabase.from('tracking_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// For local dev
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Tracking server running on port ${PORT}`);
    if (!supabase) console.log('WARNING: Supabase is NOT configured. Set SUPABASE_URL and SUPABASE_KEY env vars.');
    else console.log('Supabase client initialized.');
  });
}

// For Vercel serverless
module.exports = app;
