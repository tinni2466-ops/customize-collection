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

// Resend email client — set RESEND_API_KEY in your Render environment variables
const resend = new Resend(process.env.RESEND_API_KEY);

// Secure session so the server remembers your admin login
app.use(session({
    secret: 'customize-collection-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 }
}));

// SQLite local database
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
    socket.on('join_order_channel', (orderId) => {
        socket.join(orderId);
    });

    socket.on('send_chat_message', (data) => {
        const { orderId, senderRole, message } = data;
        db.run(`INSERT INTO order_chats (order_id, sender_role, message_content) VALUES (?, ?, ?)`,
            [orderId, senderRole, message],
            function(err) {
                if (!err) {
                    io.to(orderId).emit('receive_chat_message', { orderId, senderRole, message });
                }
            }
        );
    });
});

// Inventory & chat API
app.get('/api/inventory', (req, res) => {
    db.all("SELECT * FROM inventory", [], (err, rows) => { res.json(rows); });
});

app.post('/api/inventory/toggle', (req, res) => {
    const { id, status } = req.body;
    db.run(`UPDATE inventory SET status = ? WHERE id = ?`, [status, id], () => {
        res.json({ success: true });
    });
});

app.get('/api/chat/history/:orderId', (req, res) => {
    db.all("SELECT * FROM order_chats WHERE order_id = ? ORDER BY logged_time ASC", [req.params.orderId], (err, rows) => {
        res.json(rows);
    });
});

// =============================================================
// VERIFICATION EMAIL  —  Plaid-style template via Resend
// =============================================================

function buildVerificationEmail(code, name, websiteUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify Your Identity</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="400" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,0.12);overflow:hidden;">

          <!-- MAIN CARD -->
          <tr>
            <td align="center" style="padding:40px 40px 28px;">

              <!-- Shield icon + blue dots -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
                <tr>
                  <!-- left dots -->
                  <td style="vertical-align:middle;padding-right:10px;">
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"></span>
                  </td>
                  <!-- shield SVG -->
                  <td style="vertical-align:middle;">
                    <svg width="52" height="58" viewBox="0 0 52 58" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M26 2L4 11V28C4 40.5 13.5 52.1 26 55.5C38.5 52.1 48 40.5 48 28V11L26 2Z"
                            fill="white" stroke="#cccccc" stroke-width="1.5"/>
                      <!-- grid lines clipped inside shield -->
                      <line x1="14" y1="26" x2="38" y2="26" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="14" y1="32" x2="38" y2="32" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="14" y1="38" x2="38" y2="38" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="14" y1="20" x2="32" y2="38" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="20" y1="20" x2="38" y2="38" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="20" y1="20" x2="20" y2="44" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="26" y1="18" x2="26" y2="46" stroke="#2a2a2a" stroke-width="2.2"/>
                      <line x1="32" y1="20" x2="32" y2="44" stroke="#2a2a2a" stroke-width="2.2"/>
                    </svg>
                  </td>
                  <!-- right dots -->
                  <td style="vertical-align:middle;padding-left:10px;">
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"></span>
                  </td>
                </tr>
              </table>

              <!-- VERIFY YOUR IDENTITY -->
              <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:2px;color:#3a7dc9;text-transform:uppercase;font-family:Arial,sans-serif;">
                VERIFY YOUR IDENTITY
              </p>

              <!-- Heading -->
              <p style="margin:0 0 22px;font-size:19px;font-weight:400;color:#111111;line-height:1.45;text-align:center;font-family:Georgia,'Times New Roman',serif;">
                Enter the following code to finish linking ${websiteUrl}.
              </p>

              <!-- Code box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
                <tr>
                  <td align="center"
                      style="background:#f2f2f2;border-radius:4px;padding:18px 0;">
                    <span style="font-size:38px;font-weight:700;letter-spacing:10px;color:#111111;font-family:Georgia,'Times New Roman',serif;">
                      ${code}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Footer note -->
              <p style="margin:0;font-size:13px;color:#555555;text-align:center;line-height:1.6;font-family:Arial,sans-serif;">
                Not expecting this email?<br>
                Contact <a href="mailto:support@${websiteUrl}" style="color:#333333;text-decoration:underline;">${websiteUrl}</a> if you did not request this code.
              </p>

            </td>
          </tr>

          <!-- BOTTOM BAR -->
          <tr>
            <td align="center"
                style="background:#f0f0f0;border-top:1px solid #e0e0e0;padding:14px 40px;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#333333;text-transform:uppercase;font-family:Arial,sans-serif;">
                SECURELY POWERED BY ${websiteUrl.toUpperCase()}.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

app.post('/api/send-welcome-verify', async (req, res) => {
    const { email, code, name, websiteUrl } = req.body;

    if (!email || !code) {
        return res.status(400).json({ success: false, error: 'email and code are required' });
    }

    const site = websiteUrl || 'customize-collection.onrender.com';

    try {
        const { data, error } = await resend.emails.send({
            from: 'Customize Collection <noreply@customizecollection.publicvm.com>',
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
