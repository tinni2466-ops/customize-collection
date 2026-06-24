// backend/server.js
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const { Resend } = require('resend');
const speakeasy = require('speakeasy');
const qrcode    = require('qrcode');
const session   = require('express-session');
const multer    = require('multer');

// =============================================================
// EXPRESS APP + CORE MIDDLEWARE
// =============================================================
const app = express();
app.use(cors());
app.use(express.json());

// SESSION — session cookie (no maxAge):
//   • Survives page reloads while the browser is open
//   • Cleared automatically when the browser is fully closed
//   → Admin only needs to re-enter 2FA after a full browser close
app.use(session({
    secret: process.env.SESSION_SECRET || 'customize-collection-secret-key-123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true
        // No maxAge = session cookie; browser clears it on close
    }
}));

// =============================================================
// VOICE NOTE FILE STORAGE (multer)
// =============================================================
const voiceNotesDir = path.join(__dirname, 'public', 'voice-notes');
fs.mkdirSync(voiceNotesDir, { recursive: true });

const voiceStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, voiceNotesDir); },
    filename:    function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.webm';
        cb(null, 'voice-' + Date.now() + ext);
    }
});

const uploadVoice = multer({
    storage: voiceStorage,
    limits:  { fileSize: 15 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        cb(null, file.mimetype.startsWith('audio/'));
    }
});

// Serve recorded voice notes as static files
app.use('/voice-notes', express.static(voiceNotesDir));

// =============================================================
// RESEND EMAIL CLIENT
// =============================================================
const resend = new Resend(process.env.RESEND_API_KEY);

// =============================================================
// SQLITE DATABASE
// =============================================================
const db = new sqlite3.Database('./data.db', (err) => {
    if (err) console.error('Database connection failure:', err.message);
    else console.log('SQLite database connected.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT UNIQUE,
        category     TEXT,
        status       INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_chats (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id        TEXT,
        sender_role     TEXT,
        message_content TEXT,
        logged_time     DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id             TEXT UNIQUE,
        customer_name        TEXT,
        customer_email       TEXT,
        items                TEXT    DEFAULT '[]',
        total                REAL    DEFAULT 0,
        status               TEXT    DEFAULT 'customization_pending',
        current_phase        INTEGER DEFAULT 2,
        chat_history         TEXT    DEFAULT '[]',
        timeline             TEXT    DEFAULT '[]',
        payment_timestamp    TEXT,
        dispatch_timestamp   TEXT,
        delivery_timestamp   TEXT,
        is_delivery_finalized INTEGER DEFAULT 0,
        created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS inventory_cache (
        cache_key   TEXT PRIMARY KEY,
        cache_value TEXT
    )`);

    db.all('SELECT COUNT(*) as count FROM inventory', [], (err, rows) => {
        if (rows && rows[0].count === 0) {
            db.run(`INSERT INTO inventory (product_name, category, status) VALUES
                ('Traditional Jamdani Saree',  'Saree',    1),
                ('Pure Mulberry Silk Saree',    'Saree',    1),
                ('Designer Bridal Lehenga',     'Lehenga',  1)`);
        }
    });
});

// =============================================================
// HTTP SERVER + SOCKET.IO
// =============================================================
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
    socket.on('join_order_channel', (orderId) => socket.join(orderId));
    socket.on('join_admin_channel', ()        => socket.join('admin_room'));

    socket.on('send_chat_message', (data) => {
        const { orderId, senderRole, message } = data;
        db.run(
            `INSERT INTO order_chats (order_id, sender_role, message_content) VALUES (?, ?, ?)`,
            [orderId, senderRole, message],
            function (err) {
                if (!err) io.to(orderId).emit('receive_chat_message', { orderId, senderRole, message });
            }
        );
    });

    socket.on('order_status_update', (data) => {
        if (data && data.orderId) io.to(data.orderId).emit('order_status_changed', data);
    });
});

// =============================================================
// STATIC FILES  (serves index.html, product-details.html, etc.)
// =============================================================
app.use(express.static(path.join(__dirname, '../')));

// =============================================================
// INVENTORY ROUTES
// =============================================================
app.get('/api/inventory', (req, res) => {
    db.all('SELECT * FROM inventory', [], (err, rows) => res.json(rows));
});

app.post('/api/inventory/toggle', (req, res) => {
    const { id, status } = req.body;
    db.run('UPDATE inventory SET status = ? WHERE id = ?', [status, id], () => res.json({ success: true }));
});

app.get('/api/chat/history/:orderId', (req, res) => {
    db.all(
        'SELECT * FROM order_chats WHERE order_id = ? ORDER BY logged_time ASC',
        [req.params.orderId],
        (err, rows) => res.json(rows)
    );
});

// =============================================================
// VERIFICATION EMAIL  (Plaid-style, Logo.png from public root)
// =============================================================
function buildVerificationEmail(code, name, siteUrl) {
    const logoUrl = 'https://www.customizecollection.publicvm.com/Logo.png';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify Your Identity</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
  <tr><td align="center">
    <table width="400" cellpadding="0" cellspacing="0"
           style="background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,0.12);overflow:hidden;">
      <tr><td align="center" style="padding:40px 40px 28px;">

        <table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
          <tr>
            <td style="vertical-align:middle;padding-right:10px;">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"></span>
            </td>
            <td style="vertical-align:middle;">
              <img src="${logoUrl}" alt="Customize Collection Logo"
                   width="60" height="60"
                   style="display:block;width:60px;height:60px;object-fit:contain;border-radius:50%;border:1px solid #eeeeee;">
            </td>
            <td style="vertical-align:middle;padding-left:10px;">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"></span>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:2px;color:#3a7dc9;text-transform:uppercase;font-family:Arial,sans-serif;">
          VERIFY YOUR IDENTITY
        </p>
        <p style="margin:0 0 22px;font-size:19px;font-weight:400;color:#111111;line-height:1.45;text-align:center;font-family:Georgia,'Times New Roman',serif;">
          Enter the following code to finish linking CustomizeCollection.
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
          <tr>
            <td align="center" style="background:#f2f2f2;border-radius:4px;padding:18px 0;">
              <span style="font-size:38px;font-weight:700;letter-spacing:10px;color:#111111;font-family:Georgia,'Times New Roman',serif;">
                ${code}
              </span>
            </td>
          </tr>
        </table>

        <p style="margin:0;font-size:13px;color:#555555;text-align:center;line-height:1.6;font-family:Arial,sans-serif;">
          Not expecting this email?<br>
          Contact <a href="mailto:hello@customizecollection.publicvm.com" style="color:#333333;text-decoration:underline;">customizecollection.publicvm.com</a>
          if you did not request this code.
        </p>

      </td></tr>
      <tr>
        <td align="center" style="background:#f0f0f0;border-top:1px solid #e0e0e0;padding:14px 40px;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#333333;text-transform:uppercase;font-family:Arial,sans-serif;">
            SECURELY POWERED BY CUSTOMIZECOLLECTION.PUBLICVM.COM.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

app.post('/api/send-welcome-verify', async (req, res) => {
    const { email, code, name, websiteUrl } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'email and code are required' });

    const site = websiteUrl || 'customizecollection.publicvm.com';
    try {
        const { data, error } = await resend.emails.send({
            from:    'Customize Collection <onboarding@resend.dev>',
            to:      [email],
            subject: 'Your verification code',
            html:    buildVerificationEmail(code, name || 'there', site)
        });
        if (error) {
            console.error('Resend error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        console.log(`Verification email sent to ${email} — id: ${data.id}`);
        res.json({ success: true, id: data.id });
    } catch (err) {
        console.error('Failed to send email:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================================
// TWO-FACTOR AUTHENTICATION
// =============================================================
const admin2FASecret = 'MJ2XIZLDN5SWS33SMU2HK43VNVYWSZZV';

app.get('/setup-2fa', (req, res) => {
    const otpauthUrl = speakeasy.otpauthURL({
        secret:   admin2FASecret,
        label:    'Customize Collection Admin',
        encoding: 'base32'
    });
    qrcode.toDataURL(otpauthUrl, (err, data_url) => {
        if (err) return res.status(500).send('Error generating QR code');
        res.send(`
            <div style="font-family:Arial,sans-serif;text-align:center;padding:50px;">
                <h2>🔒 Scan with Google Authenticator</h2>
                <p>Open the app, tap <b>+</b>, then <b>Scan a QR code</b>.</p>
                <div style="margin:30px 0;">
                    <img src="${data_url}" alt="2FA QR Code"
                         style="border:2px solid #333;padding:10px;border-radius:8px;" />
                </div>
                <p style="color:#666;font-size:14px;">Once scanned your phone shows live 6-digit tokens.</p>
            </div>
        `);
    });
});

app.post('/api/verify-2fa', (req, res) => {
    const { token } = req.body;
    const verified = speakeasy.totp.verify({
        secret:   admin2FASecret,
        encoding: 'base32',
        token:    token,
        window:   1
    });

    if (verified) {
        req.session.isAdminAuthenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Token mismatch.' });
    }
});

// =============================================================
// SECURE ADMIN GATEWAY
// =============================================================
app.get('/super-admin', (req, res) => {
    const secretKey = req.query.secret;
    if (secretKey === 'x99_SecureAdmin_p77!' || req.session.isAdminAuthenticated) {
        res.sendFile(path.resolve(__dirname, '../order/history.html'));
    } else {
        res.status(404).send('Cannot GET /super-admin');
    }
});

// =============================================================
// ORDER ROUTES
// =============================================================

// ── SUBMIT NEW ORDER ──────────────────────────────────────────
app.post('/api/submit-order', (req, res) => {
    const { customer_name, customer_email, items, total_price } = req.body;
    const cleanName = (customer_name || 'Customer').replace(/[^a-zA-Z0-9 ]/g, '').trim();
    const orderId   = cleanName + ' #' + Math.floor(1000 + Math.random() * 9000);
    const now       = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const chatHistory = JSON.stringify([{
        id: Date.now(), sender: 'System',
        text: 'Order created. You can now message the store about customization.',
        stamp: now
    }]);
    const timeline = JSON.stringify([{ title: 'Payment Confirmed', time: now }]);

    db.run(
        `INSERT OR IGNORE INTO orders
            (order_id, customer_name, customer_email, items, total,
             chat_history, timeline, payment_timestamp, current_phase)
         VALUES (?,?,?,?,?,?,?,?,2)`,
        [orderId, customer_name || 'Customer', customer_email || '',
         typeof items === 'string' ? items : JSON.stringify(items),
         total_price || 0, chatHistory, timeline, now],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, orderId });
        }
    );
});

// ── GET ALL ORDERS (admin) ────────────────────────────────────
app.get('/api/all-orders', (req, res) => {
    db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return res.json([]);
        const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
        res.json(rows.map(row => ({
            orderId:             row.order_id,
            customerName:        row.customer_name,
            customerEmail:       row.customer_email,
            purchasedItems:      parse(row.items, []),
            total:               row.total,
            status:              row.status,
            currentPhase:        row.current_phase,
            chatLedgerHistory:   parse(row.chat_history, []),
            timeline:            parse(row.timeline, []),
            paymentTimestamp:    row.payment_timestamp,
            dispatchTimestamp:   row.dispatch_timestamp,
            deliveryTimestamp:   row.delivery_timestamp,
            isDeliveryFinalized: !!row.is_delivery_finalized
        })));
    });
});

// ── GET SINGLE ORDER (customer polling) ───────────────────────
app.get('/api/order/:orderId', (req, res) => {
    db.get('SELECT * FROM orders WHERE order_id = ?', [req.params.orderId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Order not found' });
        const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
        res.json({
            orderId:             row.order_id,
            customerName:        row.customer_name,
            status:              row.status,
            currentPhase:        row.current_phase,
            chatLedgerHistory:   parse(row.chat_history, []),
            timeline:            parse(row.timeline, []),
            paymentTimestamp:    row.payment_timestamp,
            dispatchTimestamp:   row.dispatch_timestamp,
            deliveryTimestamp:   row.delivery_timestamp,
            isDeliveryFinalized: !!row.is_delivery_finalized
        });
    });
});

// ── ADMIN SENDS CHAT MESSAGE ──────────────────────────────────
app.post('/api/admin-send-chat', (req, res) => {
    const { orderId, message, sender } = req.body;
    if (!orderId || !message) return res.status(400).json({ error: 'orderId and message required' });
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    db.get('SELECT chat_history FROM orders WHERE order_id = ?', [orderId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Order not found' });
        let history = [];
        try { history = JSON.parse(row.chat_history); } catch { }
        const entry = { id: Date.now(), sender: sender || 'Owner', text: message, stamp };
        history.push(entry);

        db.run('UPDATE orders SET chat_history = ? WHERE order_id = ?',
            [JSON.stringify(history), orderId],
            () => {
                io.to(orderId).emit('receive_chat_message', { orderId, ...entry });
                res.json({ success: true });
            }
        );
    });
});

// ── CUSTOMER SENDS CHAT MESSAGE ───────────────────────────────
app.post('/api/customer-send-chat', (req, res) => {
    const { orderId, message } = req.body;
    if (!orderId || !message) return res.status(400).json({ error: 'orderId and message required' });
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    db.get('SELECT chat_history FROM orders WHERE order_id = ?', [orderId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Order not found' });
        let history = [];
        try { history = JSON.parse(row.chat_history); } catch { }
        const entry = { id: Date.now(), sender: 'Customer', text: message, stamp };
        history.push(entry);

        db.run('UPDATE orders SET chat_history = ? WHERE order_id = ?',
            [JSON.stringify(history), orderId],
            () => {
                io.to('admin_room').emit('customer_message_received', { orderId, message, stamp });
                res.json({ success: true });
            }
        );
    });
});

// ── ADMIN ACCEPT / DONE ───────────────────────────────────────
app.post('/api/admin-update-order', (req, res) => {
    const { orderId, action } = req.body;
    if (!orderId || !action) return res.status(400).json({ error: 'orderId and action required' });
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let sqlSet, chatText, emitData;
    if (action === 'accept') {
        sqlSet   = 'status = ?, current_phase = ?, dispatch_timestamp = ?';
        chatText = 'Owner accepted the order. Delivery process activated.';
        emitData = { orderId, action: 'accepted', dispatchTimestamp: stamp };
    } else if (action === 'done') {
        sqlSet   = 'status = ?, is_delivery_finalized = ?, delivery_timestamp = ?';
        chatText = 'Owner marked the package as complete.';
        emitData = { orderId, action: 'delivered', deliveryTimestamp: stamp };
    } else {
        return res.status(400).json({ error: 'action must be "accept" or "done"' });
    }

    db.get('SELECT chat_history FROM orders WHERE order_id = ?', [orderId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Order not found' });
        let history = [];
        try { history = JSON.parse(row.chat_history); } catch { }
        history.push({ id: Date.now(), sender: 'System', text: chatText, stamp });

        const vals = action === 'accept'
            ? ['delivery_active', 3, stamp, JSON.stringify(history), orderId]
            : ['delivered',       1, stamp, JSON.stringify(history), orderId];

        db.run(
            `UPDATE orders SET ${sqlSet}, chat_history = ? WHERE order_id = ?`,
            vals,
            () => {
                io.to(orderId).emit('order_status_changed', emitData);
                io.to(orderId).emit('receive_chat_message', {
                    orderId, id: Date.now(), sender: 'System', text: chatText, stamp
                });
                res.json({ success: true });
            }
        );
    });
});

// =============================================================
// VOICE MESSAGE UPLOAD
// =============================================================
app.post('/api/send-voice-message', uploadVoice.single('audio'), (req, res) => {
    const { orderId, stamp } = req.body;

    if (!req.file) return res.status(400).json({ success: false, error: 'No audio file received.' });
    if (!orderId)  return res.status(400).json({ success: false, error: 'orderId is required.' });

    const audioUrl    = '/voice-notes/' + req.file.filename;
    const messageText = '🎙️ Voice note';
    const msgStamp    = stamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    db.get('SELECT chat_history FROM orders WHERE order_id = ?', [orderId], (err, row) => {
        if (err || !row) {
            io.to('admin_room').emit('customer_message_received', {
                orderId, message: messageText, isAudio: true, audioUrl, stamp: msgStamp
            });
            return res.json({ success: true, audioUrl });
        }

        let history = [];
        try { history = JSON.parse(row.chat_history || '[]'); } catch { }
        history.push({ id: Date.now(), sender: 'Customer', text: messageText, isAudio: true, audioUrl, stamp: msgStamp });

        db.run('UPDATE orders SET chat_history = ? WHERE order_id = ?',
            [JSON.stringify(history), orderId],
            () => {
                io.to('admin_room').emit('customer_message_received', {
                    orderId, message: messageText, isAudio: true, audioUrl, stamp: msgStamp
                });
                res.json({ success: true, audioUrl });
            }
        );
    });
});

// =============================================================
// INVENTORY CACHE SYNC
// =============================================================
app.post('/api/sync-inventory', (req, res) => {
    const { cache } = req.body;
    if (!cache || typeof cache !== 'object') return res.status(400).json({ error: 'cache object required' });

    const stmt = db.prepare('INSERT OR REPLACE INTO inventory_cache (cache_key, cache_value) VALUES (?, ?)');
    Object.entries(cache).forEach(([k, v]) => stmt.run(k, JSON.stringify(v)));
    stmt.finalize(() => {
        io.emit('inventory_cache_updated', { cache });
        res.json({ success: true });
    });
});

app.get('/api/get-inventory-cache', (req, res) => {
    db.all('SELECT cache_key, cache_value FROM inventory_cache', [], (err, rows) => {
        if (err) return res.json({});
        const cache = {};
        rows.forEach(r => { try { cache[r.cache_key] = JSON.parse(r.cache_value); } catch { } });
        res.json(cache);
    });
});

// =============================================================
// START SERVER
// =============================================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
