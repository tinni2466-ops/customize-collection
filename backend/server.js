// backend/server.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Resend } = require('resend');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const session = require('express-session');

const app = express();
// ✅ Allow both the old Render domain AND your new custom domain to send orders
app.use(cors({
    origin: [
        'https://customize-collection.onrender.com', 
        'https://customizecollection.publicvm.com'
    ],
    credentials: true // This is critical! It allows the cart/order sessions to pass through
}));

app.use(express.json());

// Resend client — RESEND_API_KEY must be set in Render environment variables
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Tell Express it is safe to create sessions for the new custom domain on Render
app.set('trust proxy', 1);

app.use(session({
    secret: 'customize-collection-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 }
}));

// The Pool auto-connects using the DATABASE_URL environment variable we will set up next
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for secure cloud database hosting
    }
});

// Verify connection and initialize table structure
const initDB = async () => {
    try {
        // 1. Setup Orders Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                customer_name TEXT,
                items TEXT,
                total_price NUMERIC,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Setup Order Chats Table (Crucial for keeping your live support functioning!)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_chats (
                id SERIAL PRIMARY KEY,
                order_id TEXT,
                sender_role TEXT,
                message_content TEXT,
                logged_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("PostgreSQL Database connected and initialized smoothly.");
    } catch (err) {
        console.error("Database initialization failed:", err.message);
    }
};

initDB();

// Export the pool to use it across your routes files
module.exports = pool;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    socket.on('join_order_channel', (orderId) => socket.join(orderId));

    // ✅ FIXED: Converted from SQLite db.run to PostgreSQL pool.query
    socket.on('send_chat_message', async (data) => {
        const { orderId, senderRole, message } = data;
        try {
            await pool.query(
                `INSERT INTO order_chats (order_id, sender_role, message_content) VALUES ($1, $2, $3)`,
                [orderId, senderRole, message]
            );
            io.to(orderId).emit('receive_chat_message', { orderId, senderRole, message });
        } catch (err) {
            console.error("Failed to save chat message to cloud:", err.message);
        }
    });
});

// ✅ Send real database orders to the super admin panel
app.get('/api/all-orders', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM orders ORDER BY id DESC");
        
        // PostgreSQL nests rows inside a 'rows' property of the response object
        res.json(result.rows); 
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server failed to fetch records." });
    }
});

// ✅ NEW: Catch incoming checkout requests and save them directly to PostgreSQL
app.post('/api/submit-order', async (req, res) => {
    const { customer_name, items, total_price } = req.body;

    // Safety check: Ensure we aren't saving empty data
    if (!customer_name || !items) {
        return res.status(400).json({ success: false, error: "Missing required order information." });
    }

    try {
        // Convert items array/object into a clean string if it isn't one already
        const finalizedItems = typeof items === 'object' ? JSON.stringify(items) : items;

        const queryText = `
            INSERT INTO orders (customer_name, items, total_price) 
            VALUES ($1, $2, $3) 
            RETURNING id, created_at;
        `;
        
        const result = await pool.query(queryText, [customer_name, finalizedItems, total_price || 0]);
        const newOrder = result.rows[0];

        console.log(`[SUCCESS] Order #${newOrder.id} generated for ${customer_name}`);
        
        res.status(201).json({ 
            success: true, 
            message: "Order placed successfully!", 
            orderId: newOrder.id 
        });

    } catch (err) {
        console.error("Database failed to save customer order:", err.message);
        res.status(500).json({ success: false, error: "Internal server database error." });
    }
});

app.post('/api/send-welcome-verify', async (req, res) => {
    const { email, code, name, websiteUrl } = req.body;

    // 1. Debug log: This checks if the frontend's 2-digit code is reaching the backend safely
    console.log(`[BACKEND RECEIVED] Email: ${email} | Code From Frontend: ${code} | Name: ${name}`);

    // 2. Safety Check: If code is missing, do not send a broken email
    if (!code) {
        return res.status(400).json({ success: false, error: 'Backend failed to collect the code from the frontend.' });
    }

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const site = websiteUrl || 'customizecollection.publicvm.com';

    try {
        // 3. Send using Resend
        const { data, error } = await resend.emails.send({
            from: 'Customize Collection <hello@customizecollection.publicvm.com>', 
            to: [email],
            subject: `Your identity verification code: ${code}`, 
            html: buildVerificationEmail(code, name || 'there', site) 
        });

        if (error) {
            console.error('Resend error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`[SUCCESS] Email sent to ${email} with code: ${code}`);
        res.json({ success: true, id: data.id });

    } catch (err) {
        console.error('Failed to send email:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ FIXED: Converted from SQLite db.all to async PostgreSQL query
app.get('/api/chat/history/:orderId', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM order_chats WHERE order_id = $1 ORDER BY logged_time ASC",
            [req.params.orderId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Failed to fetch chat history:", err.message);
        res.status(500).json({ error: "Could not load message logs." });
    }
});

// =============================================================
// VERIFICATION EMAIL  —  Plaid-style layout, no inline SVG
// Logo is served from your public website folder
// =============================================================

function buildVerificationEmail(code, name, siteUrl) {
    const logoUrl = 'https://www.customizecollection.publicvm.com/Logo.png';

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Verify Your Identity</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
      <tr>
        <td align="center">
          <table
            width="400"
            cellpadding="0"
            cellspacing="0"
            style="background:#ffffff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,0.12);overflow:hidden;"
          >
            <tr>
              <td align="center" style="padding:40px 40px 28px;">
                <table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
                  <tr>
                    <td style="vertical-align:middle;padding-right:10px;">
                      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"></span>
                      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"></span>
                    </td>
                    <td style="vertical-align:middle;">
                      <img
                        src="https://www.customizecollection.publicvm.com/Logo.png"
                        alt="Customize Collection Logo"
                        width="60"
                        height="60"
                        style="display:block;width:60px;height:60px;object-fit:contain;border-radius:50%;border:1px solid #eeeeee;"
                      />
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

                <p style="margin:0 0 22px;font-size:11px;font-weight:400;color:#111111;line-height:1.45;text-align:center;font-family:Georgia,'Times New Roman',serif;">
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
                  Not expecting this email?<br />
                  Contact
                  <a href="mailto:hello@customizecollection.publicvm.com" style="color:#333333;text-decoration:underline;">customizecollection.publicvm.com</a>
                  if you did not request this code.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="background:#f0f0f0;border-top:1px solid #e0e0e0;padding:14px 40px;">
                <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#333333;text-transform:uppercase;font-family:Arial,sans-serif;">
                  SECURELY POWERED BY CUSTOMIZECOLLECTION.PUBLICVM.COM.
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
                    <img src="${data_url}" alt="2FA QR Code" style="border:2px solid #333;padding:10px;border-radius:8px;" />
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

server.listen(3000, () => console.log('Server running on port 3000'));

// =============================================================
// INBOUND EMAIL WEBHOOK (RECEIVING MAILS)
// =============================================================

app.post('/api/webhook/receive-email', async (req, res) => {
    const emailData = req.body;

    const fromUser = emailData.from;       
    const subject = emailData.subject;     
    const textPlain = emailData.text;

    console.log(`New Email Received from ${fromUser}!`);
    console.log(`Subject: ${subject}`);
    console.log(`Content: ${textPlain}`);

    // ✅ FIXED: Converted commented template block safely to Postgres syntax
    /*
    try {
        await pool.query(
            `INSERT INTO order_chats (order_id, sender_role, message_content) VALUES ($1, $2, $3)`,
            ["EXTRACTED_ORDER_ID", "user", textPlain]
        );
        console.log("Saved email reply to chat history.");
    } catch (err) {
        console.error("Failed to record webhook mail:", err.message);
    }
    */

    res.status(200).json({ received: true });
});
