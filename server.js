/* ═══════════════════════════════════════════════════════════════
   SINAIYAH EYE CENTER — OMNICHANNEL MESSAGE HUB
   One inbox for every patient channel, with photos & videos.

   INBOUND (patient → board):
     🌐 Website   POST /api/web/message          (chat widget / booking form)
     📘 Facebook  GET+POST /webhook/facebook     (Messenger Platform)
     💜 Viber     POST /webhook/viber            (Viber Bot API)
     💚 WhatsApp  GET+POST /webhook/whatsapp     (WhatsApp Cloud API)
     📧 Email     POST /webhook/email            (SendGrid Inbound Parse / generic JSON)
     📱 SMS       POST /webhook/sms              (httpSMS on the clinic Android phone)

   OUTBOUND (staff reply on the board → patient):
     POST /api/reply  (multipart: text + image/video files)
     → delivered via the conversation's native channel API.

   Media: inbound attachments are downloaded into ./media and served
   at GET /media/:file so the board can display them; outbound files
   are uploaded to ./media then sent by URL (FB/Viber/WA) or as
   base64 attachments (email). SMS is text-only in PH — media is
   delivered as a link appended to the text.

   Run:  npm install && npm start   (Node 18+)
═══════════════════════════════════════════════════════════════ */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── Config ──────────────────────────────────────────────────── */
const PORT            = process.env.PORT || 3900;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ('http://localhost:' + PORT); // needed so channels can fetch media
const STAFF_KEY       = process.env.STAFF_KEY || 'change-me-staff-key';
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'change-me-webhook-secret';   // for sms/email/web hooks
const ALLOW_ORIGIN    = process.env.ALLOW_ORIGIN || '*';

// SMS — httpSMS (clinic Android phone + Globe/Smart SIM)
const CLINIC_PHONE    = process.env.CLINIC_PHONE || '+639510026722';
const HTTPSMS_API_KEY = process.env.HTTPSMS_API_KEY || '';

// Facebook Messenger
const FB_PAGE_TOKEN   = process.env.FB_PAGE_TOKEN || '';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'sinaiyah-fb-verify';

// Viber bot
const VIBER_TOKEN     = process.env.VIBER_TOKEN || '';

// WhatsApp Cloud API
const WA_TOKEN        = process.env.WA_TOKEN || '';
const WA_PHONE_ID     = process.env.WA_PHONE_ID || '';
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'sinaiyah-wa-verify';

// Email — Resend for outbound (https://resend.com); inbound via SendGrid Parse or any relay
const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const EMAIL_FROM      = process.env.EMAIL_FROM || 'Sinaiyah Eye Center <info@sinaiyaheye.com>';

const DATA_FILE  = path.join(__dirname, 'data', 'conversations.json');
const CONTENT_FILE = path.join(__dirname, 'data', 'site-content.json');
const MEDIA_DIR  = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/* Default site content — used the first time the server runs, or as a
   fallback for any field an admin hasn't customized yet. Keeps the
   editor form always populated even before any edits are saved. */
const DEFAULT_CONTENT = {
  hero: {
    eyebrow: "Protecting the Gift of Sight · Est. 2016 · Malasiqui, Pangasinan",
    headline: "Pangasinan's Trusted",
    headlineAccent: "Eye Care Center",
    tagline: "Since 2016.",
    missionLead: "Protecting the Gift of Sight. Restoring Independence.",
    missionBody: "For more than a decade, Sinaiyah Eye Center has helped thousands of patients preserve their vision and regain their quality of life. With over 10,000 successful eye surgeries performed, our team provides advanced cataract surgery, glaucoma, retinal, and comprehensive eye care in Pangasinan — close to home, so families across Pangasinan receive exceptional treatment without traveling far from the people who matter most."
  },
  stats: {
    stat1Number: "11,000+", stat1Label: "Patients served",
    stat2Number: "10,000+", stat2Label: "Successful surgeries"
  },
  contact: {
    phoneDisplay: "0951-002-6722",
    phoneLink: "+639510026722",
    email: "info@sinaiyaheye.com",
    address: "Malasiqui, Pangasinan"
  },
  doctorSchedule: {}, // keyed by "YYYY-MM-DD" -> [{ doctor, time, note }]
  doctorPatients: {}, // keyed by doctor name -> [{ id, name, contact, address, diagnosis, laterality, status }]
  patients: [], // Patient's Board — [{ id, name, contact, address, diagnosis, stage, opdForm }]
  doctorPhoto: { url: "" }, // uploaded once, shown next to the day's schedule
  celebration: { photo: "", caption: "" }, // "Sinaiyah's Celebration Month" card
  gallery: [], // patient photo entries: { url, caption, addedAt }
  staff: [], // staff entries: { url, name, role, addedAt }
  doctors: [], // doctor entries: { url, name, specialty, addedAt }
  ceoCorner: { url: "", name: "", title: "", message: "" }
};

function loadContent() {
  try { return JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')); }
  catch { return JSON.parse(JSON.stringify(DEFAULT_CONTENT)); }
}
function saveContent(content) {
  fs.mkdirSync(path.dirname(CONTENT_FILE), { recursive: true });
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2));
}
function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const k in patch) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
      out[k] = deepMerge(base[k] || {}, patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}

/* ── Store ───────────────────────────────────────────────────── */
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { conversations: [] }; }
}
function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

/* ── Helpers ─────────────────────────────────────────────────── */
function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[^\d+]/g, '');
  if (p.startsWith('09')) p = '+63' + p.slice(1);
  else if (p.startsWith('639')) p = '+' + p;
  else if (p.startsWith('9') && p.length === 10) p = '+63' + p;
  return p;
}
function convoId(channel, externalId) {
  return channel + '-' + crypto.createHash('md5').update(String(externalId)).digest('hex').slice(0, 10);
}
function getOrCreateConvo(db, channel, externalId, name, contact) {
  const id = convoId(channel, externalId);
  let c = db.conversations.find(x => x.id === id);
  if (!c) {
    c = { id, channel, externalId: String(externalId), name: name || contact || externalId,
          contact: contact || '', stage: 'Lead', unread: false, archived: false, messages: [] };
    db.conversations.unshift(c);
  } else if (name && (c.name === c.externalId || c.name === c.contact)) {
    c.name = name; // upgrade placeholder name when the channel gives us a real one
  }
  return c;
}
function pushInbound(channel, externalId, { name, contact, text, attachments }) {
  const db = load();
  const c = getOrCreateConvo(db, channel, externalId, name, contact);
  c.messages.push({ direction: 'in', text: text || '', ts: Date.now(), attachments: attachments || [] });
  c.unread = true;
  save(db);
  console.log('[IN ' + channel + ']', c.name, '→', text || '(' + (attachments || []).map(a => a.type).join(',') + ')');
  return c;
}
function attTypeFromMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}
function extFromMime(mime) {
  const map = { 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp',
                'video/mp4':'mp4','video/3gpp':'3gp','video/quicktime':'mov','application/pdf':'pdf' };
  return map[mime] || 'bin';
}
// Download a remote attachment into ./media, return a local attachment record
async function fetchToMedia(url, headers, mimeHint, nameHint) {
  try {
    const res = await fetch(url, { headers: headers || {} });
    if (!res.ok) throw new Error('http ' + res.status);
    const mime = res.headers.get('content-type') || mimeHint || 'application/octet-stream';
    const file = crypto.randomBytes(8).toString('hex') + '.' + extFromMime(mime.split(';')[0]);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
    return { type: attTypeFromMime(mime), url: PUBLIC_BASE_URL + '/media/' + file, mime, name: nameHint || file };
  } catch (e) {
    console.warn('[media] download failed, keeping remote URL:', e.message);
    return { type: attTypeFromMime(mimeHint), url, mime: mimeHint || '', name: nameHint || 'attachment' };
  }
}
function saveBase64ToMedia(b64, mime, nameHint) {
  const file = crypto.randomBytes(8).toString('hex') + '.' + extFromMime(mime);
  fs.writeFileSync(path.join(MEDIA_DIR, file), Buffer.from(b64, 'base64'));
  return { type: attTypeFromMime(mime), url: PUBLIC_BASE_URL + '/media/' + file, mime, name: nameHint || file };
}

/* ── Outbound delivery per channel ───────────────────────────── */
async function jpost(url, headers, body) {
  const res = await fetch(url, { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body) });
  if (!res.ok) throw new Error(url.split('?')[0] + ' → ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json().catch(() => ({}));
}

const deliver = {
  async sms(c, text, atts) {
    // PH carrier SMS can't carry media — append hosted links instead.
    let content = text || '';
    if (atts.length) content += (content ? '\n' : '') + atts.map(a => '📎 ' + a.url).join('\n');
    if (!HTTPSMS_API_KEY) { console.warn('[SMS] simulated send →', c.contact, content); return; }
    await jpost('https://api.httpsms.com/v1/messages/send', { 'x-api-key': HTTPSMS_API_KEY },
      { from: CLINIC_PHONE, to: c.contact, content });
  },
  async facebook(c, text, atts) {
    if (!FB_PAGE_TOKEN) { console.warn('[FB] simulated send →', c.externalId, text, atts.length); return; }
    const base = 'https://graph.facebook.com/v19.0/me/messages?access_token=' + FB_PAGE_TOKEN;
    if (text) await jpost(base, {}, { recipient: { id: c.externalId }, message: { text } });
    for (const a of atts) {
      await jpost(base, {}, { recipient: { id: c.externalId },
        message: { attachment: { type: a.type === 'video' ? 'video' : 'image', payload: { url: a.url, is_reusable: true } } } });
    }
  },
  async viber(c, text, atts) {
    if (!VIBER_TOKEN) { console.warn('[Viber] simulated send →', c.externalId, text, atts.length); return; }
    const base = 'https://chatapi.viber.com/pa/send_message';
    const h = { 'X-Viber-Auth-Token': VIBER_TOKEN };
    if (text) await jpost(base, h, { receiver: c.externalId, type: 'text', text });
    for (const a of atts) {
      if (a.type === 'image') await jpost(base, h, { receiver: c.externalId, type: 'picture', text: '', media: a.url });
      else if (a.type === 'video') {
        let size = 0; try { size = fs.statSync(path.join(MEDIA_DIR, path.basename(a.url))).size; } catch {}
        await jpost(base, h, { receiver: c.externalId, type: 'video', media: a.url, size });
      } else await jpost(base, h, { receiver: c.externalId, type: 'text', text: '📎 ' + a.url });
    }
  },
  async whatsapp(c, text, atts) {
    if (!WA_TOKEN || !WA_PHONE_ID) { console.warn('[WA] simulated send →', c.contact, text, atts.length); return; }
    const base = 'https://graph.facebook.com/v19.0/' + WA_PHONE_ID + '/messages';
    const h = { Authorization: 'Bearer ' + WA_TOKEN };
    const to = c.contact.replace('+', '');
    if (text) await jpost(base, h, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    for (const a of atts) {
      if (a.type === 'image') await jpost(base, h, { messaging_product: 'whatsapp', to, type: 'image', image: { link: a.url } });
      else if (a.type === 'video') await jpost(base, h, { messaging_product: 'whatsapp', to, type: 'video', video: { link: a.url } });
      else await jpost(base, h, { messaging_product: 'whatsapp', to, type: 'document', document: { link: a.url, filename: a.name } });
    }
  },
  async email(c, text, atts) {
    if (!RESEND_API_KEY) { console.warn('[Email] simulated send →', c.contact, text, atts.length); return; }
    const attachments = atts.map(a => {
      const p = path.join(MEDIA_DIR, path.basename(a.url));
      return { filename: a.name, content: fs.readFileSync(p).toString('base64') };
    });
    // Reply from whichever mailbox the patient/staff originally wrote to —
    // admin@ conversations get replies from admin@, everything else from info@.
    const fromAddr = c.mailbox === 'admin'
      ? 'Sinaiyah Eye Center Admin <admin@sinaiyaheye.com>'
      : EMAIL_FROM;
    await jpost('https://api.resend.com/emails', { Authorization: 'Bearer ' + RESEND_API_KEY }, {
      from: fromAddr, to: [c.contact],
      subject: 'Re: your message to Sinaiyah Eye Center',
      text: text || '(see attachment)', attachments
    });
  },
  async web(_c, _text, _atts) {
    /* Web-channel replies are stored only; the site's chat widget can poll
       GET /api/web/thread/:id (below) to show them to the visitor. */
  }
};

/* ── App ─────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (_req, f, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(f.originalname || '.bin'))
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 6 }
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-staff-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const requireStaff = (req, res, next) =>
  req.headers['x-staff-key'] === STAFF_KEY ? next() : res.status(401).json({ error: 'unauthorized' });
const requireSecret = (req, res, next) =>
  (req.query.secret || req.headers['x-webhook-secret']) === WEBHOOK_SECRET ? next() : res.status(401).json({ error: 'bad secret' });

/* ════════ INBOUND WEBHOOKS ════════ */

/* 🌐 WEBSITE — chat widget & booking form post here (media as base64 optional) */
app.post('/api/web/message', requireSecret, (req, res) => {
  const b = req.body || {};
  if (!b.text && !(b.attachments || []).length) return res.status(400).json({ error: 'empty' });
  const atts = (b.attachments || []).map(a => saveBase64ToMedia(a.contentBase64, a.mime || 'application/octet-stream', a.name));
  const key = b.contact || b.sessionId || ('anon-' + crypto.randomBytes(4).toString('hex'));
  const c = pushInbound('web', key, { name: b.name, contact: b.contact, text: b.text, attachments: atts });
  res.json({ ok: true, conversationId: c.id });
});
// Widget polls its own thread for staff replies
app.get('/api/web/thread/:id', (req, res) => {
  const c = load().conversations.find(x => x.id === req.params.id && x.channel === 'web');
  res.json({ messages: c ? c.messages : [] });
});

/* 📱 SMS — httpSMS webhook or generic {from, message} */
app.post('/webhook/sms', requireSecret, (req, res) => {
  const b = req.body || {};
  let from, text;
  if (b.data && (b.type || '').includes('received')) { from = b.data.contact || b.data.from; text = b.data.content; }
  else { from = b.from || b.sender || b.phone; text = b.message || b.text || b.content; }
  from = normalizePhone(from);
  if (!from || !text) return res.status(400).json({ error: 'missing from/message' });
  const c = pushInbound('sms', from, { contact: from, text });
  res.json({ ok: true, conversationId: c.id });
});

/* 📘 FACEBOOK MESSENGER */
app.get('/webhook/facebook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === FB_VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook/facebook', async (req, res) => {
  res.sendStatus(200); // ack fast, process after
  try {
    for (const entry of (req.body.entry || [])) {
      for (const ev of (entry.messaging || [])) {
        if (!ev.message || ev.message.is_echo) continue;
        const psid = ev.sender.id;
        const atts = [];
        for (const a of (ev.message.attachments || [])) {
          if (a.payload && a.payload.url) atts.push(await fetchToMedia(a.payload.url, {}, a.type === 'video' ? 'video/mp4' : 'image/jpeg'));
        }
        let name = '';
        if (FB_PAGE_TOKEN) {
          try {
            const r = await fetch('https://graph.facebook.com/' + psid + '?fields=first_name,last_name&access_token=' + FB_PAGE_TOKEN);
            const j = await r.json(); name = [j.first_name, j.last_name].filter(Boolean).join(' ');
          } catch {}
        }
        pushInbound('facebook', psid, { name: name || 'Messenger user', text: ev.message.text, attachments: atts });
      }
    }
  } catch (e) { console.error('[FB webhook]', e.message); }
});

/* 💜 VIBER */
app.post('/webhook/viber', async (req, res) => {
  res.json({ status: 0 }); // Viber requires fast 200
  try {
    const b = req.body || {};
    if (b.event !== 'message' || !b.sender) return;
    const m = b.message || {};
    const atts = [];
    if (m.media && (m.type === 'picture' || m.type === 'video' || m.type === 'file')) {
      atts.push(await fetchToMedia(m.media, {}, m.type === 'video' ? 'video/mp4' : (m.type === 'picture' ? 'image/jpeg' : ''), m.file_name));
    }
    pushInbound('viber', b.sender.id, { name: b.sender.name, text: m.text, attachments: atts });
  } catch (e) { console.error('[Viber webhook]', e.message); }
});

/* 💚 WHATSAPP CLOUD API */
app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
async function waMediaToLocal(mediaId, mimeHint) {
  const meta = await (await fetch('https://graph.facebook.com/v19.0/' + mediaId, {
    headers: { Authorization: 'Bearer ' + WA_TOKEN } })).json();
  return fetchToMedia(meta.url, { Authorization: 'Bearer ' + WA_TOKEN }, meta.mime_type || mimeHint);
}
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    for (const entry of (req.body.entry || [])) {
      for (const ch of (entry.changes || [])) {
        const v = ch.value || {};
        const name = (((v.contacts || [])[0] || {}).profile || {}).name || '';
        for (const m of (v.messages || [])) {
          const from = normalizePhone(m.from);
          const atts = [];
          let text = '';
          if (m.type === 'text') text = m.text.body;
          else if (m.type === 'image') { atts.push(await waMediaToLocal(m.image.id, 'image/jpeg')); text = m.image.caption || ''; }
          else if (m.type === 'video') { atts.push(await waMediaToLocal(m.video.id, 'video/mp4')); text = m.video.caption || ''; }
          else if (m.type === 'document') { atts.push(await waMediaToLocal(m.document.id, m.document.mime_type)); text = m.document.caption || ''; }
          pushInbound('whatsapp', from, { name, contact: from, text, attachments: atts });
        }
      }
    }
  } catch (e) { console.error('[WA webhook]', e.message); }
});

/* 📧 EMAIL — SendGrid Inbound Parse (multipart) or generic JSON */
app.post('/webhook/email', requireSecret, upload.any(), (req, res) => {
  const b = req.body || {};
  const fromRaw = b.from || '';
  const fromEmail = (fromRaw.match(/<([^>]+)>/) || [null, fromRaw])[1].trim().toLowerCase();
  const fromName = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  if (!fromEmail) return res.status(400).json({ error: 'missing from' });

  // Which clinic mailbox did this land in? SendGrid Inbound Parse sends the
  // recipient in `to` (or inside `envelope` as JSON). Default to 'info' if
  // we can't tell — patient/staff mail is the common case, and defaulting
  // there (not 'admin') keeps anything ambiguous visible to everyone rather
  // than accidentally hiding it from the people who need to see it.
  let toRaw = b.to || '';
  if (!toRaw && b.envelope) {
    try { toRaw = (JSON.parse(b.envelope).to || [])[0] || ''; } catch {}
  }
  const mailbox = /admin@/i.test(toRaw) ? 'admin' : 'info';

  const atts = [];
  for (const f of (req.files || [])) {
    atts.push({ type: attTypeFromMime(f.mimetype), url: PUBLIC_BASE_URL + '/media/' + f.filename, mime: f.mimetype, name: f.originalname });
  }
  for (const a of (b.attachments || [])) { // JSON style
    if (a.contentBase64) atts.push(saveBase64ToMedia(a.contentBase64, a.mime || '', a.name));
  }
  const text = [b.subject ? '✉️ ' + b.subject : '', b.text || ''].filter(Boolean).join('\n');
  const c = pushInbound('email', fromEmail, { name: fromName || fromEmail, contact: fromEmail, text, attachments: atts });
  c.mailbox = mailbox; // 'info' (all staff) or 'admin' (admin-only)
  const db = load();
  const stored = db.conversations.find(x => x.id === c.id);
  if (stored) { stored.mailbox = mailbox; save(db); }
  res.json({ ok: true, conversationId: c.id, mailbox });
});

/* ════════ STAFF API (the message board) ════════ */

app.get('/api/conversations', requireStaff, (req, res) => {
  res.json({ conversations: load().conversations });
});

/* Reply with text and/or media files — routed to the patient's channel */
app.post('/api/reply', requireStaff, upload.array('files', 6), async (req, res) => {
  const conversationId = req.body.conversationId;
  const text = (req.body.text || '').trim();
  const db = load();
  const c = db.conversations.find(x => x.id === conversationId);
  if (!c) return res.status(404).json({ error: 'conversation not found' });
  const atts = (req.files || []).map(f => ({
    type: attTypeFromMime(f.mimetype), url: PUBLIC_BASE_URL + '/media/' + f.filename, mime: f.mimetype, name: f.originalname
  }));
  if (!text && !atts.length) return res.status(400).json({ error: 'empty reply' });
  try {
    await (deliver[c.channel] || deliver.web)(c, text, atts);
    c.messages.push({ direction: 'out', text, ts: Date.now(), attachments: atts });
    save(db);
    console.log('[OUT ' + c.channel + ']', c.name, '←', text || '(media)');
    res.json({ ok: true, attachments: atts });
  } catch (e) {
    console.error('[OUT FAILED ' + c.channel + ']', e.message);
    res.status(502).json({ error: 'send failed', detail: e.message });
  }
});

/* Start a brand-new outbound conversation (staff-initiated) on any channel.
   channel: 'sms' | 'whatsapp' | 'email' | 'facebook' | 'viber'
   contact: phone (SMS/WhatsApp), email address (Email), or the patient's
            PSID (Facebook) / Viber user ID (Viber) — those two only work if
            the platform has issued one already (patient must have messaged
            the page/bot at least once; this is a Meta/Viber policy limit,
            not a limitation of this server). */
app.post('/api/compose', requireStaff, upload.array('files', 6), async (req, res) => {
  const channel = req.body.channel;
  const name = (req.body.name || '').trim();
  let contact = (req.body.contact || '').trim();
  const text = (req.body.text || '').trim();
  if (!['sms', 'whatsapp', 'email', 'facebook', 'viber'].includes(channel))
    return res.status(400).json({ error: 'invalid channel' });
  if (!contact) return res.status(400).json({ error: 'missing recipient' });
  if (channel === 'sms' || channel === 'whatsapp') contact = normalizePhone(contact);
  const atts = (req.files || []).map(f => ({
    type: attTypeFromMime(f.mimetype), url: PUBLIC_BASE_URL + '/media/' + f.filename, mime: f.mimetype, name: f.originalname
  }));
  if (!text && !atts.length) return res.status(400).json({ error: 'empty message' });

  const db = load();
  const c = getOrCreateConvo(db, channel, contact, name, contact);
  if (channel === 'email') c.mailbox = req.body.mailbox === 'admin' ? 'admin' : 'info';
  try {
    await (deliver[channel] || deliver.web)(c, text, atts);
    c.messages.push({ direction: 'out', text, ts: Date.now(), attachments: atts });
    save(db);
    console.log('[NEW ' + channel + ']', c.name, '←', text || '(media)');
    res.json({ ok: true, conversationId: c.id });
  } catch (e) {
    console.error('[COMPOSE FAILED ' + channel + ']', e.message);
    res.status(502).json({ error: 'send failed', detail: e.message });
  }
});

app.post('/api/read', requireStaff, (req, res) => {
  const db = load();
  const c = db.conversations.find(x => x.id === (req.body || {}).conversationId);
  if (c) { c.unread = false; save(db); }
  res.json({ ok: true });
});
app.post('/api/rename', requireStaff, (req, res) => {
  const { conversationId, name } = req.body || {};
  const db = load();
  const c = db.conversations.find(x => x.id === conversationId);
  if (c && name) { c.name = String(name).slice(0, 80); save(db); }
  res.json({ ok: true });
});

/* Archive / unarchive a conversation (kept in storage, hidden from the main list) */
app.post('/api/archive', requireStaff, (req, res) => {
  const { conversationId, archived } = req.body || {};
  const db = load();
  const c = db.conversations.find(x => x.id === conversationId);
  if (!c) return res.status(404).json({ error: 'conversation not found' });
  c.archived = !!archived;
  save(db);
  res.json({ ok: true, archived: c.archived });
});

/* Permanently delete a conversation and its downloaded media */
app.delete('/api/conversations/:id', requireStaff, (req, res) => {
  const db = load();
  const idx = db.conversations.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'conversation not found' });
  const [removed] = db.conversations.splice(idx, 1);
  save(db);
  (removed.messages || []).forEach(m => (m.attachments || []).forEach(a => {
    try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(a.url))); } catch {}
  }));
  res.json({ ok: true });
});

/* ════════ SITE CONTENT — admin-editable, no reupload needed ════════
   The public website fetches GET /api/content on every page load and
   overwrites the corresponding text on the page. Admin edits it from
   the Edit Board tab; changes go live for every visitor immediately. */

/* Public — every visitor's browser calls this, no auth. */
app.get('/api/content', (_req, res) => {
  res.json(loadContent());
});

/* Admin-only in the UI (client-side gated); server just requires the
   shared staff key, matching the pattern used for the doctor schedule. */
app.post('/api/content', requireStaff, (req, res) => {
  const current = loadContent();
  const updated = deepMerge(current, req.body || {});
  saveContent(updated);
  res.json({ ok: true, content: updated });
});

/* Upload a photo into a named single-photo field (doctorPhoto or celebration).
   Body: field=doctorPhoto|celebration, optional caption, multipart photo. */
app.post('/api/content/photo', requireStaff, upload.single('photo'), (req, res) => {
  const field = req.body.field;
  if (!['doctorPhoto', 'celebration', 'ceoCorner'].includes(field)) return res.status(400).json({ error: 'invalid field' });
  if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
  const content = loadContent();
  const url = PUBLIC_BASE_URL + '/media/' + req.file.filename;
  if (field === 'doctorPhoto') content.doctorPhoto = { url };
  else if (field === 'ceoCorner') {
    content.ceoCorner = content.ceoCorner || {};
    content.ceoCorner.url = url;
    content.ceoCorner.name = (req.body.name || content.ceoCorner.name || '').slice(0, 80);
    content.ceoCorner.title = (req.body.title || content.ceoCorner.title || '').slice(0, 80);
    content.ceoCorner.message = (req.body.message || content.ceoCorner.message || '').slice(0, 600);
  }
  else content.celebration = { photo: url, caption: (req.body.caption || content.celebration.caption || '').slice(0, 200) };
  saveContent(content);
  res.json({ ok: true, content });
});

/* Add a patient photo to the gallery (multipart upload) */
app.post('/api/content/gallery', requireStaff, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
  const caption = (req.body.caption || '').slice(0, 120);
  const content = loadContent();
  content.gallery = content.gallery || [];
  content.gallery.push({
    url: PUBLIC_BASE_URL + '/media/' + req.file.filename,
    caption,
    addedAt: Date.now()
  });
  saveContent(content);
  res.json({ ok: true, gallery: content.gallery });
});

/* Remove a patient photo from the gallery by index */
app.delete('/api/content/gallery/:index', requireStaff, (req, res) => {
  const i = parseInt(req.params.index, 10);
  const content = loadContent();
  const gallery = content.gallery || [];
  if (i < 0 || i >= gallery.length) return res.status(404).json({ error: 'not found' });
  const [removed] = gallery.splice(i, 1);
  saveContent(content);
  try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(removed.url))); } catch {}
  res.json({ ok: true, gallery });
});

/* ── Staff section ── admin adds each staff member's photo + name + role
   via the Edit Board; they render in "Meet Our Staff" on the public site. */
app.post('/api/content/staff', requireStaff, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
  const name = (req.body.name || '').slice(0, 80);
  const role = (req.body.role || '').slice(0, 80);
  if (!name) return res.status(400).json({ error: 'missing name' });
  const content = loadContent();
  content.staff = content.staff || [];
  content.staff.push({
    url: PUBLIC_BASE_URL + '/media/' + req.file.filename,
    name,
    role,
    addedAt: Date.now()
  });
  saveContent(content);
  res.json({ ok: true, staff: content.staff });
});

app.delete('/api/content/staff/:index', requireStaff, (req, res) => {
  const i = parseInt(req.params.index, 10);
  const content = loadContent();
  const staff = content.staff || [];
  if (i < 0 || i >= staff.length) return res.status(404).json({ error: 'not found' });
  const [removed] = staff.splice(i, 1);
  saveContent(content);
  try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(removed.url))); } catch {}
  res.json({ ok: true, staff });
});

/* ── Doctors section ── same pattern as staff, own array so it renders
   as its own "Meet Our Doctors" carousel, separate from general staff. */
app.post('/api/content/doctors', requireStaff, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
  const name = (req.body.name || '').slice(0, 80);
  const specialty = (req.body.specialty || '').slice(0, 80);
  if (!name) return res.status(400).json({ error: 'missing name' });
  const content = loadContent();
  content.doctors = content.doctors || [];
  content.doctors.push({
    url: PUBLIC_BASE_URL + '/media/' + req.file.filename,
    name,
    specialty,
    addedAt: Date.now()
  });
  saveContent(content);
  res.json({ ok: true, doctors: content.doctors });
});

app.delete('/api/content/doctors/:index', requireStaff, (req, res) => {
  const i = parseInt(req.params.index, 10);
  const content = loadContent();
  const doctors = content.doctors || [];
  if (i < 0 || i >= doctors.length) return res.status(404).json({ error: 'not found' });
  const [removed] = doctors.splice(i, 1);
  saveContent(content);
  try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(removed.url))); } catch {}
  res.json({ ok: true, doctors });
});

app.get('/health', (_req, res) => res.json({ ok: true, channels: ['web','facebook','viber','whatsapp','email','sms'] }));

app.listen(PORT, () => {
  console.log('Sinaiyah omnichannel hub on http://localhost:' + PORT);
  console.log('Public base for media:', PUBLIC_BASE_URL);
});
