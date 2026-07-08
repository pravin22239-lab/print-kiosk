require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');
const cors = require('cors');
const { nanoid } = require('nanoid');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Figure out the public URL to put in the QR code.
// If BASE_URL is set in .env to something other than localhost, trust it.
// Otherwise, auto-detect from the incoming request so a new tunnel URL
// (ngrok/localtunnel/cloudflared) just works without editing .env every time.
function getBaseUrl(req) {
  const envBase = process.env.BASE_URL;
  if (envBase && !envBase.includes('localhost') && !envBase.includes('127.0.0.1')) {
    return envBase.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// ---------- tiny JSON "database" ----------
const DB_FILE = path.join(__dirname, 'data', 'db.json');
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      rates: { bw: 2, color: 5 }, // rupees per page
      sessions: {},              // sessionId -> { fileId, filename, options, price, status }
      queue: []                  // paid jobs, in print order
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- file uploads ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = nanoid(10);
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type. Use PDF, Word, or an image.'));
  }
});

// ---------- Razorpay ----------
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

// =========================================================
// KIOSK: create a new session + QR code for the display
// =========================================================
app.post('/api/session', async (req, res) => {
  const db = loadDB();
  const sessionId = nanoid(8);
  db.sessions[sessionId] = {
    createdAt: Date.now(),
    status: 'waiting_for_upload', // waiting_for_upload -> awaiting_payment -> paid -> printed
    fileId: null,
    filename: null,
    options: null,
    price: null
  };
  saveDB(db);

  const orderUrl = `${getBaseUrl(req)}/order.html?session=${sessionId}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(orderUrl, { margin: 1, width: 400 });
    res.json({ sessionId, orderUrl, qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

// Kiosk polls this to know when to move on (upload -> pay -> printed)
app.get('/api/session/:id', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json(session);
});

// =========================================================
// CUSTOMER: pricing, upload, order options
// =========================================================
app.get('/api/rates', (req, res) => {
  const db = loadDB();
  res.json(db.rates);
});

// Admin-style endpoint to change prices later — no auth yet, add before going live
app.post('/api/rates', (req, res) => {
  const { bw, color } = req.body;
  const db = loadDB();
  if (typeof bw === 'number') db.rates.bw = bw;
  if (typeof color === 'number') db.rates.color = color;
  saveDB(db);
  res.json(db.rates);
});

// Best-effort page count so the customer doesn't have to type it in.
// PDF: exact count. DOCX: rough estimate from word count. Images/.doc: 1.
async function detectPages(filePath, ext) {
  try {
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return Math.max(1, data.numpages || 1);
    }
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      const words = result.value.trim().split(/\s+/).filter(Boolean).length;
      return Math.max(1, Math.round(words / 500)); // ~500 words/page estimate
    }
  } catch (err) {
    console.error('Page detection failed:', err.message);
  }
  return 1; // .jpg/.jpeg/.png/.doc, or anything detection failed on
}

app.post('/api/upload/:sessionId', upload.single('file'), async (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const pages = await detectPages(req.file.path, ext);

  session.fileId = req.file.filename;
  session.filename = req.file.originalname;
  session.detectedPages = pages;
  session.status = 'awaiting_payment';
  saveDB(db);

  res.json({ fileId: req.file.filename, filename: req.file.originalname, pages });
});

function calcPrice(rates, options) {
  // Flat per-copy pricing: rate is charged once per copy, regardless of page count.
  // e.g. 10 copies @ ₹2 = ₹20 (NOT rate × pages × copies).
  const perCopy = options.color === 'color' ? rates.color : rates.bw;
  const copies = Math.max(1, parseInt(options.copies, 10) || 1);
  let total = perCopy * copies;
  if (options.sides === 'double') total = Math.ceil(total * 0.6); // rough double-side discount
  return Math.round(total);
}

app.post('/api/quote/:sessionId', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  const options = {
    pages: req.body.pages,
    copies: req.body.copies,
    color: req.body.color === 'color' ? 'color' : 'bw',
    sides: req.body.sides === 'double' ? 'double' : 'single',
    paperSize: req.body.paperSize || 'A4'
  };
  const price = calcPrice(db.rates, options);

  session.options = options;
  session.price = price;
  saveDB(db);

  res.json({ price, options });
});

// =========================================================
// PAYMENT: create Razorpay order, verify signature after checkout
// =========================================================
app.post('/api/pay/create-order/:sessionId', async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: 'Payment gateway not configured. Add RAZORPAY_KEY_ID / SECRET to .env' });
  }
  const db = loadDB();
  const session = db.sessions[req.params.sessionId];
  if (!session || !session.price) {
    return res.status(400).json({ error: 'No priced order for this session yet' });
  }

  try {
    const order = await razorpay.orders.create({
      amount: session.price * 100, // paise
      currency: 'INR',
      receipt: req.params.sessionId,
      notes: { sessionId: req.params.sessionId, filename: session.filename }
    });
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not create payment order', detail: err.message });
  }
});

app.post('/api/pay/verify/:sessionId', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const db = loadDB();
  const session = db.sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  session.status = 'paid';
  session.paymentId = razorpay_payment_id;
  db.queue.push({
    id: nanoid(8),
    sessionId: req.params.sessionId,
    filename: session.filename,
    fileId: session.fileId,
    options: session.options,
    price: session.price,
    paidAt: Date.now(),
    printed: false
  });
  saveDB(db);

  res.json({ ok: true });
});

// =========================================================
// PRINT QUEUE (this is where you plug in a real printer later)
// =========================================================
app.get('/api/queue', (req, res) => {
  const db = loadDB();
  res.json(db.queue.slice().reverse());
});

app.post('/api/queue/:jobId/printed', (req, res) => {
  const db = loadDB();
  const job = db.queue.find(j => j.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.printed = true;
  job.printedAt = Date.now();

  // Reset the kiosk session tied to this job so the kiosk display moves on
  const session = db.sessions[job.sessionId];
  if (session) session.status = 'printed';

  saveDB(db);
  res.json({ ok: true });
});

// Serve uploaded files (for admin preview / actual printing later)
app.use('/uploads', express.static(UPLOAD_DIR));

app.listen(PORT, () => {
  console.log(`\nPrint kiosk server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Kiosk:   http://localhost:${PORT}/kiosk.html`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html`);
  console.log(`  (QR codes auto-detect the public URL from each request, e.g. your tunnel URL)`);
  if (!razorpay) {
    console.log(`\n⚠️  Razorpay keys not set — payment will fail until you add them to .env\n`);
  }
});
