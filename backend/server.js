// backend/server.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const { Resend } = require('resend');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const session = require('express-session');

const app = express();
app.use(cors());
app.use(express.json());

// Resend client — RESEND_API_KEY must be set in Render environment variables
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(session({
    secret: 'customize-collection-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 }
}));

const db = new sqlite3.Database('./data.db', (err) => {
    if (err) console.error("Database connection failure:", err.message);
    else console.log('SQLite database connected.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT UNIQUE,
        category TEXT,
        status INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        sender_role TEXT,
        message_content TEXT,
        logged_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.all("SELECT COUNT(*) as count FROM inventory", [], (err, rows) => {
        if (rows && rows[0].count === 0) {
            db.run(`INSERT INTO inventory (product_name, category, status) VALUES 
                ('Traditional Jamdani Saree', 'Saree', 1),
                ('Pure Mulberry Silk Saree', 'Saree', 1),
                ('Designer Bridal Lehenga', 'Lehenga', 1)`);
        }
    });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    socket.on('join_order_channel', (orderId) => socket.join(orderId));

    socket.on('send_chat_message', (data) => {
        const { orderId, senderRole, message } = data;
        db.run(`INSERT INTO order_chats (order_id, sender_role, message_content) VALUES (?, ?, ?)`,
            [orderId, senderRole, message],
            function(err) {
                if (!err) io.to(orderId).emit('receive_chat_message', { orderId, senderRole, message });
            }
        );
    });
});

app.get('/api/inventory', (req, res) => {
    db.all("SELECT * FROM inventory", [], (err, rows) => res.json(rows));
});

app.post('/api/inventory/toggle', (req, res) => {
    const { id, status } = req.body;
    db.run(`UPDATE inventory SET status = ? WHERE id = ?`, [status, id], () => res.json({ success: true }));
});

app.get('/api/chat/history/:orderId', (req, res) => {
    db.all("SELECT * FROM order_chats WHERE order_id = ? ORDER BY logged_time ASC",
        [req.params.orderId], (err, rows) => res.json(rows));
});

// =============================================================
// VERIFICATION EMAIL  —  Plaid-style layout, no inline SVG
// Logo is served from your public website folder
// =============================================================

function buildVerificationEmail(code, name, siteUrl) {
    // Logo must be uploaded to your GitHub repo public root as "Logo.png"
    // so it is reachable at https://customize-collection.onrender.com/Logo.png
    const logoUrl = 'https://www.customizecollection.publicvm.com/Logo.png';

    return `<!DOCTYPE html>
<html lang="en">
hello world
</html>`;
}

app.post('/api/send-welcome-verify', async (req, res) => {
    const { email, code, name, websiteUrl } = req.body;

    if (!email || !code) {
        return res.status(400).json({ success: false, error: 'email and code are required' });
    }

    const site = websiteUrl || 'customizecollection.publicvm.com';

    try {
        const { data, error } = await resend.emails.send({
            from: 'Customize Collection <hello@customizecollection.publicvm.com>', // ✅ Change to hello@customizecollection.publicvm.com after verifying domain on resend.com/domains
            to: [email],
            subject: 'Your verification code',
            html: buildVerificationEmail(code, name || 'there', site)
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
        secret: admin2FASecret,
        label: 'Customize Collection Admin',
        encoding: 'base32'
    });

    qrcode.toDataURL(otpauthUrl, (err, data_url) => {
        if (err) return res.status(500).send("Error generating QR code");
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
        secret: admin2FASecret,
        encoding: 'base32',
        token: token,
        window: 1
    });

    if (verified) {
        req.session.isAdminAuthenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Token mismatch." });
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

app.use(express.static(path.join(__dirname, '../')));

server.listen(3000, () => console.log('Server running on https://customize-collection.onrender.com'));

// =============================================================
// INBOUND EMAIL WEBHOOK (RECEIVING MAILS)
// =============================================================

app.post('/api/webhook/receive-email', (req, res) => {
    const emailData = req.body;

    // Resend sends the email structure in the request body
    const fromUser = emailData.from;       // e.g., "John Doe <user@gmail.com>"
    const subject = emailData.subject;     // e.g., "Re: Your verification code"
    const textHtml = emailData.html;       // The message body they typed
    const textPlain = emailData.text;

    console.log(` New Email Received from ${fromUser}!`);
    console.log(`Subject: ${subject}`);
    console.log(`Content: ${textPlain}`);

    // OPTIONAL: Insert this reply directly into your SQLite Chat database!
    // If the subject contains an Order ID, you can automatically map it:
    /*
    db.run(`INSERT INTO order_chats (order_id, sender_role, message_content) VALUES (?, ?, ?)`,
        ["EXTRACTED_ORDER_ID", "user", textPlain],
        (err) => { if (!err) console.log("Saved email reply to chat history."); }
    );
    */

    // Always return a 200 OK status to let Resend know you received it safely
    res.status(200).json({ received: true });
});
