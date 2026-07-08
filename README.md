# PrintPoint — QR Print Kiosk

Scan a QR code → upload a file → choose print options → pay by UPI → job lands in a print queue.

## What's included

- `server.js` — Express backend: sessions, uploads, pricing, Razorpay orders, payment verification, print queue
- `public/kiosk.html` — the screen that sits at the kiosk showing the "scan to print" QR code
- `public/order.html` — the page that opens on the customer's phone after scanning
- `public/admin.html` — print queue view for whoever is operating the printer
- `data/db.json` — auto-created simple JSON database (sessions, prices, queue)
- `uploads/` — where customer files are stored

No physical printer is wired up yet (you said you don't have one). Paid jobs land in
`admin.html` as "ready to print" — see **Connecting a real printer** below for the one
piece of code you'll add later.

## 1. Install

You'll need [Node.js](https://nodejs.org) 18+ installed. Then, in this folder:

```bash
npm install
```

## 2. Get Razorpay test keys (free, ~2 minutes)

1. Sign up at https://dashboard.razorpay.com/signup
2. In the dashboard, make sure the **Test Mode** toggle (top right) is ON
3. Go to Settings → API Keys → Generate Test Key
4. Copy the Key ID and Key Secret

Enable UPI in test mode: Settings → Payment Methods → make sure UPI is turned on
(it usually is by default).

## 3. Configure

```bash
cp .env.example .env
```

Open `.env` and paste in your test `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.

**Important — BASE_URL:** the QR code on the kiosk screen has to point somewhere
a phone can actually reach. `localhost` won't work once you scan with a real phone.
For testing, use a free tunnel:

```bash
# in a separate terminal
npx localtunnel --port 3000
# or, if you have it: ngrok http 3000
```

Copy the `https://...` URL it gives you into `BASE_URL` in `.env`.

## 4. Run

```bash
npm start
```

You'll see:

```
Kiosk:   https://your-tunnel-url/kiosk.html
Admin:   https://your-tunnel-url/admin.html
```

- Put `kiosk.html` on the screen at your kiosk (a tablet in kiosk/fullscreen mode works well)
- Keep `admin.html` open wherever the person feeding the printer is sitting
- Scan the QR with any phone camera to test the customer flow end-to-end

Razorpay test mode gives you fake UPI/card flows that always succeed instantly —
no real money moves until you swap in live keys.

## 5. Go live later

1. Switch Razorpay dashboard out of Test Mode, complete their KYC (needed to accept
   real payments), generate **live** keys, and swap them into `.env`
2. Point `BASE_URL` at your real domain (deploy the server somewhere like Railway,
   Render, or a VPS — needs to stay running 24/7, not your laptop)
3. Set your real prices: `POST /api/rates` with `{"bw": 2, "color": 5}` (rupees/page),
   or just add a tiny form to `admin.html` later

## Connecting a real printer (when you get one)

In `server.js`, inside `POST /api/queue/:jobId/printed`, that's a *manual* "mark done"
button right now. To auto-print instead, right after a job is marked paid
(`POST /api/pay/verify/:sessionId`), you'd send the file to the printer. The common approach
on Linux/Mac:

```js
const { exec } = require('child_process');
exec(`lp -d YOUR_PRINTER_NAME -n ${session.options.copies} uploads/${session.fileId}`);
```

This uses CUPS (built into Mac/Linux, installable on Windows). Run `lpstat -p` to see your
printer's name once it's connected. I can wire this up properly once you have the hardware —
happy to do that in a follow-up.

## Notes on this being a "real kiosk"

A few things worth doing before this handles real customers and real money:

- **Admin auth**: `admin.html` and the `/api/rates` endpoint have no password right now —
  anyone with the URL can see the queue or change prices. Add basic auth before deploying.
- **Session cleanup**: old sessions/files never get deleted. Add a daily cron job to clear
  `uploads/` and old entries in `data/db.json`.
- **File size/type limits**: currently capped at 50MB, PDF/Word/images only — adjust in
  `server.js` if you need to allow more.
