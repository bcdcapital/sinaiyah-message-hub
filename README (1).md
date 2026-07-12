# Sinaiyah Eye Center — Omnichannel Message Hub

One staff message board, six patient sources, with photos and videos in both directions.

| Source | Inbound (patient → board) | Outbound (staff → patient) | Media |
|---|---|---|---|
| 🌐 Website | chat widget & booking form post to `/api/web/message` | stored; widget can poll `/api/web/thread/:id` | base64 upload |
| 📘 Facebook | Messenger Platform webhook | FB Send API | photos & videos ✔ |
| 💜 Viber | Viber Bot API webhook | `send_message` | photos & videos ✔ |
| 💚 WhatsApp | WhatsApp Cloud API webhook | Cloud API messages | photos & videos ✔ |
| 📧 Email | SendGrid Inbound Parse (or any relay) | Resend API | attachments ✔ |
| 📱 SMS | httpSMS on the clinic Android phone | httpSMS send | text only — media sent as hosted links |

Inbound media (patient photos of their eye, videos, prescriptions) is downloaded into `./media` and shown inline on the board. Staff can attach photos/videos with the 📎 button in either board; files are delivered natively per channel.

## Run

```bash
cd message-hub
npm install
npm start          # http://localhost:3900
```

All credentials are environment variables — set only the channels you're activating; the rest simulate sends and log to console (great for demos):

```bash
PORT=3900
PUBLIC_BASE_URL=https://hub.sinaiyaheye.com   # must be public so channels can fetch media
STAFF_KEY=long-random-1                        # board → hub auth
WEBHOOK_SECRET=long-random-2                   # sms/email/web hooks
ALLOW_ORIGIN=https://sinaiyaheye.com

# SMS (httpSMS app on the clinic phone, https://httpsms.com)
CLINIC_PHONE=+639510026722
HTTPSMS_API_KEY=...

# Facebook Messenger (Meta app + Page)
FB_PAGE_TOKEN=...
FB_VERIFY_TOKEN=sinaiyah-fb-verify

# Viber (create a bot at partners.viber.com)
VIBER_TOKEN=...

# WhatsApp Cloud API (Meta Business)
WA_TOKEN=...
WA_PHONE_ID=...
WA_VERIFY_TOKEN=sinaiyah-wa-verify

# Email outbound (resend.com)
RESEND_API_KEY=...
EMAIL_FROM="Sinaiyah Eye Center <info@sinaiyaheye.com>"
```

## Wire up each channel

1. **Website** — already wired: the site's chatbot leads and booking-form submissions mirror into the hub automatically. Set `HUB_API_BASE`, `HUB_STAFF_KEY`, `HUB_SECRET` near the top of the site's `<script>`.
2. **Facebook** — Meta App → Messenger → webhook URL `https://HUB/webhook/facebook`, verify token = `FB_VERIFY_TOKEN`, subscribe to `messages`. Generate a Page token → `FB_PAGE_TOKEN`.
3. **Viber** — create a bot account, then `POST https://chatapi.viber.com/pa/set_webhook` with your token and `{"url":"https://HUB/webhook/viber"}`.
4. **WhatsApp** — Meta Business → WhatsApp → configure webhook `https://HUB/webhook/whatsapp` with `WA_VERIFY_TOKEN`; note the phone number ID.
5. **Email** — point your domain's inbound parse (SendGrid Inbound Parse / Mailgun Routes) at `https://HUB/webhook/email?secret=WEBHOOK_SECRET`.
6. **SMS** — httpSMS app on the clinic phone; webhook `https://HUB/webhook/sms?secret=WEBHOOK_SECRET` for `message.phone.received`.

## Test everything offline

```bash
# SMS text
curl -X POST "localhost:3900/webhook/sms?secret=change-me-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"from":"09171234567","message":"Magkano po cataract surgery?"}'

# Email with subject
curl -X POST "localhost:3900/webhook/email?secret=change-me-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"from":"Ana Cruz <ana@example.com>","subject":"Follow-up","text":"Attached is my prescription."}'

# Website message
curl -X POST "localhost:3900/api/web/message?secret=change-me-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"name":"Web Visitor","contact":"09998887777","text":"Open po ba kayo Saturday?"}'
```

Each appears on the board within ~8 s, tagged with its channel and **LIVE**. Reply with text or a 📎 photo/video — with no channel keys set, the hub logs a simulated delivery so the full loop is demoable offline.

## Edit Board — no more reuploading the HTML

Admin-only tab in the staff panel that edits the website's hero text, stats, contact info, and patient photo gallery, saved to `data/site-content.json` on this server. Every visitor's page fetches `GET /api/content` on load and overwrites the matching text/images — so a saved edit is live for everyone within seconds, with no file upload required.

- `GET /api/content` — public, no auth (the website itself calls this)
- `POST /api/content` — staff key required; body is a partial object merged into existing content, e.g. `{"hero":{"headline":"New headline"}}`
- `POST /api/content/gallery` — staff key required, multipart `photo` file + `caption`; appends a patient photo
- `DELETE /api/content/gallery/:index` — staff key required; removes a photo by its position in the list

**Note on permissions:** like the Schedule Board, "Admin only" is enforced in the browser (the Edit Board tab is hidden unless `currentStaff.role === 'admin'`), not by the server — the server only checks the one shared staff key. That matches the trust model already in place for this small internal tool; it's not bulletproof against someone editing the JS directly, but it's consistent with everything else here.

If the hub server is down, the website simply keeps whatever text/images are already baked into the HTML file — nothing breaks for visitors.

## Starting a new conversation (not just replying)

Both boards now have an **✏️ New Message** button. Staff pick a channel, enter the recipient (phone, email, or platform ID) and a message, and the hub creates the conversation and sends the first message — this hits `POST /api/compose` (multipart: `channel`, `name`, `contact`, `text`, `files[]`).

- **SMS / Email**: works for any phone number or email address — no prior contact needed.
- **WhatsApp**: works for any number, subject to Meta's 24-hour business messaging window / template rules outside it.
- **Facebook / Viber**: can only message a patient who has *already* messaged the clinic's Page or bot at least once — that's a platform policy, not a limitation of this server. Staff need the patient's PSID (Facebook) or Viber user ID, both of which show up once that first inbound message arrives.

## Doctor schedule is now shared (fixes "Doctor is in!" going missing)

The Schedule Board used to save to each browser's local storage — so a Clinic Coordinator's update on the clinic PC wouldn't show up on the Admin's phone, and the "Doctor is in!" banner could look "missing" even though a doctor really was scheduled. It's now stored in `site-content.json` under `doctorSchedule` (keyed by date), fetched and saved through the same `/api/content` endpoint — every device sees the same calendar.

## Doctor Photo & Sinaiyah's Celebration Month

Two more single-photo fields, uploaded from the Edit Board:

- `doctorPhoto` — shown on the larger "doctor on duty" card beneath the compact banner. Date/time on that card still come from the Schedule Board automatically; only the photo is separately uploaded.
- `celebration` — `{ photo, caption }`. This card only appears on the site once a photo has been uploaded; leaving it empty keeps it hidden.

Both use `POST /api/content/photo` (staff key required, multipart `photo` + `field` = `doctorPhoto` or `celebration`, optional `caption` for celebration).

## Two email mailboxes: info@ vs admin@

The hub now knows the difference between mail sent to `info@sinaiyaheye.com` and `admin@sinaiyaheye.com`:

- **`info@sinaiyaheye.com`** — patients and staff. Shows up in the Message Board for everyone.
- **`admin@sinaiyaheye.com`** — Admin only. Never appears in the board (not even hidden/greyed) for Shella, Liza, or the Clinic Coordinator — the conversation is filtered out entirely unless `currentStaff.role === 'admin'`.

This is detected from the `to` address SendGrid's Inbound Parse sends on each inbound email; anything not explicitly addressed to `admin@` defaults to `info@` (safer to over-share than to accidentally hide a patient message from staff who need it).

Replies go out from whichever address the conversation came in on — so replying to an admin@ thread sends from admin@, and info@ threads send from info@. When Admin starts a brand-new email conversation from the compose modal, they get a "Send from" dropdown to choose; everyone else always sends from info@.

**To make both addresses actually work**, you need:
1. Both `info@sinaiyaheye.com` and `admin@sinaiyaheye.com` to exist as real mailboxes in Google Workspace (or wherever your domain email lives)
2. SendGrid Inbound Parse configured on a subdomain (see below) so mail sent to *either* address gets forwarded to `/webhook/email`

## Setting up the other channels

### 📧 Email (inbound)
Outbound already works via Resend (`RESEND_API_KEY`, already wired up). Inbound needs a separate step because Resend doesn't receive mail — only sends it:
1. Pick a subdomain just for this, e.g. `mail.sinaiyaheye.com` (keeps it separate from your main Google Workspace mail setup, so nothing conflicts)
2. Sign up at **sendgrid.com** (free tier is fine), go to **Settings → Inbound Parse**
3. Add that subdomain, point its **MX record** (in Hostinger DNS) to SendGrid's mail servers (SendGrid shows you the exact record when you add the subdomain)
4. Set the **Destination URL** to `https://your-hub-url.onrender.com/webhook/email?secret=YOUR_WEBHOOK_SECRET`
5. Forward `info@sinaiyaheye.com` and `admin@sinaiyaheye.com` mail to something like `anything@mail.sinaiyaheye.com` (a Gmail filter/forward rule works) so it actually reaches SendGrid's inbound address

### 📘 Facebook Messenger
1. Create a **Meta for Developers** account at developers.facebook.com, create a new App
2. Add the **Messenger** product to the app
3. Under Messenger → Settings, generate a **Page Access Token** for the clinic's Facebook Page → this is `FB_PAGE_TOKEN`
4. Set up a webhook: Callback URL = `https://your-hub-url.onrender.com/webhook/facebook`, Verify Token = anything you choose (must match `FB_VERIFY_TOKEN`)
5. Subscribe the webhook to the `messages` field
6. Add `FB_PAGE_TOKEN` and `FB_VERIFY_TOKEN` as environment variables on Render

### 💜 Viber
1. Create a **Viber Bot** at partners.viber.com (needs a Viber Business/Bot account)
2. Get the bot's **Auth Token** → this is `VIBER_TOKEN`
3. Call Viber's `set_webhook` API once (a single API request) pointing to `https://your-hub-url.onrender.com/webhook/viber` — Viber's docs walk through this with a simple curl command
4. Add `VIBER_TOKEN` as an environment variable on Render

### 💚 WhatsApp
1. In the same Meta Developer App as Facebook (or a new one), add the **WhatsApp** product
2. Meta gives you a **test phone number** immediately for development — get its **Phone Number ID** (`WA_PHONE_ID`) and a temporary **Access Token** (`WA_TOKEN`)
3. Set up the webhook the same way as Facebook: Callback URL = `https://your-hub-url.onrender.com/webhook/whatsapp`, Verify Token = your choice (`WA_VERIFY_TOKEN`)
4. Subscribe to the `messages` field
5. **Note:** moving from the free test number to your real clinic number for production use requires Meta's business verification process — this can take a few days, so it's worth starting early if you want WhatsApp live soon
6. Add `WA_PHONE_ID`, `WA_TOKEN`, and `WA_VERIFY_TOKEN` as environment variables on Render

## Staff roles and access

| Role | Message Board | Patient's Board | Schedule Board | Edit Board |
|---|---|---|---|---|
| **Admin** | ✅ | ✅ | ✅ (edit calendar) | ✅ |
| **Clinic Coordinator** | ✅ | ✅ | ✅ (edit calendar) | ❌ |
| **Staff** | ✅ | ✅ | ✅ (view only) | ❌ |
| **Doctor** | ❌ | ❌ | ✅ — but only their own surgery/patient list, not the clinic-wide calendar | ❌ |

Doctor accounts are created by Admin from Manage Staff, same as any other role, with one extra field: a **Doctor name** that must match how that doctor's name appears in the Schedule Board calendar (e.g. "Reyes"). That's what links the account to their own patient list — get this wrong and their list will be empty.

## Doctor's Surgery / Patient List

Each doctor has their own list, stored on the hub under `content.doctorPatients` (keyed by doctor name), with per-patient: name, contact number, address, diagnosis, laterality (OD/OS/OU), and a status of **Pending → Done → Discharged**.

- **Doctor role** sees only their own list, scoped by their `doctorName` — no dropdown, no way to see another doctor's patients.
- **Admin and Clinic Coordinator** get a dropdown to pick which doctor's list to view or manage (useful for covering, correcting entries, etc.).
- Everything saves through the same generic `/api/content` endpoint used for the doctor schedule — no new server routes were needed.

## Patient's Board — now shared, plus the OPD Form

The Patient's Board pipeline used to be sample data living only in the browser — now it's saved to `content.patients` on the hub, same as everything else, so every device sees the same board.

**Pipeline stages** (renamed to match how the clinic actually works):
For Consultation → For Surgery → Surgery Today → Discharged / Refused

**OPD Form** — matches the clinic's actual paper intake form (OPM Form - Ophtha). From any patient card, staff click "Start/Continue OPD Form" to open a form covering:
- Patient Information (name, address, contact, PHIC/HMO, civil status, occupation, etc.)
- Medical History (Hypertension, Diabetes, Glaucoma, etc. — checkbox + year, matching the paper form)
- Surgeries (Cataract Removal, Pterygium Excision, Trabeculectomy, YAG Capsulotomy — each Left/Right eye + year)
- Social History & Vitals
- Consult History — Visual Acuity (OD/OS, without/with pinhole) and Chief Complaints

**Save** keeps the data on the patient's record (persists through every later pipeline stage — surgery scheduling, discharge, etc. can all reference it later). **Save & Print** opens a print-ready copy of the same form layout with the entered data filled in, plus the diagram sections (Ocular Motility, Slit Lamp, Fundus, Gonioscopy, etc.) left blank exactly as on the paper form — those are for the doctor to draw on by hand during the actual exam, so they're intentionally not digitized.

## Notes
- Conversations are keyed per channel identity (phone / PSID / Viber ID / email), so repeat messages thread correctly.
- `POST /api/rename` attaches a real patient name to a conversation.
- `POST /api/archive` `{conversationId, archived}` hides/restores a conversation from the main inbox without deleting it. The board's **🗄 Archive** button (row-level and in an open thread) calls this; **🗄 View Archived** toggles the list.
- `DELETE /api/conversations/:id` permanently removes a conversation and its downloaded media files. The board's **🗑 Delete** button calls this after a confirmation prompt — this cannot be undone.
- Storage is JSON + a media folder — swap for SQLite/Supabase + S3 when volume grows.
- RA 10173: messages and media contain patient health information. Serve over HTTPS, restrict `ALLOW_ORIGIN`, rotate keys, and consider signed media URLs before production.
