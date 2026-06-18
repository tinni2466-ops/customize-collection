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

// Set up secure session monitoring so the server remembers your phone login
app.use(session({
    secret: 'customize-collection-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 } // Session expires after 10 minutes of inactivity
}));

// Initialize Resend with your developer API token key
const resend = new Resend('re_8MV9w32o_NgVFTFaLeWKiMRkq8dCwDuDN');

// Initialize the SQLite local persistent database file
const db = new sqlite3.Database('./data.db', (err) => {
    if (err) console.error("Database connection failure:", err.message);
    else console.log('SQLite internal tracking data database file generated and connected safely.');
});

// Build the functional structure database tables
db.serialize(() => {
    // Inventory monitoring table
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT UNIQUE,
        category TEXT,
        status INTEGER DEFAULT 1
    )`);

    // Chat logging storage table mapping message paths
    db.run(`CREATE TABLE IF NOT EXISTS order_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        sender_role TEXT, 
        message_content TEXT,
        logged_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Check and populate base inventory elements if data table is completely empty
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

// Open communication channels via WebSockets mapping framework
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

// REST API Endpoints for administration interface frameworks
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

// Optimized dynamic email verification processing system
app.post('/api/send-welcome-verify', async (req, res) => {
    const { email, code, name } = req.body;
    try {
        const response = await resend.emails.send({
            from: "customizecollection <otp@customizecollection.publicvm.com>",
            to: email,
            subject: 'Welcome to Customize Collection! Confirm Your Code',
            headers: { 'X-Priority': '1', 'Importance': 'high' }, 
            html: `
                <div style="font-family: Arial, sans-serif; padding: 25px; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="color: #0b57d0; margin-top: 0;">Welcome to Customize Collection, ${name}!</h2>
                    <p style="font-size: 15px; color: #333;">Thank you for registering an account on our platform.</p>
                    <p style="font-size: 15px; color: #333; font-weight: bold;">Your 2-digit confirmation code validation marker is:</p>
                    <div style="background: #f1f3f4; padding: 15px; font-size: 36px; font-weight: bold; text-align: center; letter-spacing: 5px; color: #0b57d0; border-radius: 8px; margin: 15px 0;">
                        ${code}
                    </div>
                    <p style="font-size: 12px; color: #666; margin-bottom: 0;">If you did not initiate this validation request, please safely disregard this email layout block.</p>
                </div>`
        });

        if (response.error) {
            console.error("Resend System API Warning:", response.error.message);
            return res.status(400).json({ success: false, error: response.error.message });
        }

        console.log(`Verification code successfully dispatched to target destination: ${email}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Failed to execute email routing sequence:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// TWO-FACTOR AUTHENTICATION SETUP & TRACKING
// ==========================================

// Private static base32 code string key for Google Authenticator app pairing setup
const admin2FASecret = 'MJ2XIZLDN5SWS33SMU2HK43VNVYWSZZV';

// NEW: A clean webpage route that automatically builds and displays your QR code!
app.get('/setup-2fa', (req, res) => {
    const otpauthUrl = speakeasy.otpauthURL({ 
        secret: admin2FASecret, 
        label: 'Customize Collection Admin', 
        encoding: 'base32' 
    });

    qrcode.toDataURL(otpauthUrl, (err, data_url) => {
        if (err) {
            return res.status(500).send("Error generating QR code");
        }
        // This sends a neat, clean webpage directly to your browser screen
        res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                <h2>🔒 Scan This Code with Google Authenticator App</h2>
                <p>Open the app on your phone, tap the <b>+</b> button, and select <b>Scan a QR code</b>.</p>
                <div style="margin: 30px 0;">
                    <img src="${data_url}" alt="2FA QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px;" />
                </div>
                <p style="color: #666; font-size: 14px;">Once scanned, your phone will start displaying your 6-digit access tokens!</p>
            </div>
        `);
    });
});

// Endpoint verifying your telephone device authorization status token code inputs
app.post('/api/verify-2fa', (req, res) => {
    const { token } = req.body;

    const verified = speakeasy.totp.verify({
        secret: admin2FASecret,
        encoding: 'base32',
        token: token,
        window: 1 // 30 second flexibility timer offset window
    });

    if (verified) {
        req.session.isAdminAuthenticated = true; 
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Verification tracking sequence mismatched." });
    }
});

// ==========================================
// THE SECURE GATEWAY ROUTE CONTROLLER
// ==========================================
app.get('/super-admin', (req, res) => {
    const secretKey = req.query.secret;

    // Checks if you entered the secret link query OR if you have already logged in via your phone session
    if (secretKey === 'x99_SecureAdmin_p77!' || req.session.isAdminAuthenticated) { 
        res.sendFile(path.resolve(__dirname, '../order/history.html'));
    } else {
        res.status(404).send('Cannot GET /super-admin');
    }
});

// Keep this line below the gateway so it handles generic public store assets safely
app.use(express.static(path.join(__dirname, '../')));

// Run unified backend app server container framework mapping layout pipelines
server.listen(3000, () => console.log('Unified Server running on http://localhost:3000'));
