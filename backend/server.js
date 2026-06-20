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

    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        customer_email TEXT,
        items TEXT,
        total_price REAL,
        status TEXT DEFAULT 'Pending',
        order_date DATETIME DEFAULT CURRENT_TIMESTAMP
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

// ✅ Send real database orders to the super admin panel
app.get('/api/all-orders', (req, res) => {
    db.all("SELECT * FROM orders ORDER BY order_date DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
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
            // Using the verified subdomain route we discussed to prevent immediate bounces
            from: 'Customize Collection <hello@customizecollection.publicvm.com>', 
            to: [email],
            subject: `Your identity verification code: ${code}`, // Puts it in the subject line too!
            html: buildVerificationEmail(code, name || 'there', site) // Passes the frontend code to the HTML template
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
            <!-- MAIN CARD -->
            <tr>
              <td align="center" style="padding:40px 40px 28px;">
                <!-- Logo + blue dot decorations -->
                <table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
                  <tr>
                    <!-- left dots -->
                    <td style="vertical-align:middle;padding-right:10px;">
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"
                      ></span>
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"
                      ></span>
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"
                      ></span>
                    </td>
                    <!-- logo image — NO inline SVG -->
                    <td style="vertical-align:middle;">
                      <img
                        src="https://www.customizecollection.publicvm.com/Logo.png"
                        alt="Customize Collection Logo"
                        width="60"
                        height="60"
                        style="display:block;width:60px;height:60px;object-fit:contain;border-radius:50%;border:1px solid #eeeeee;"
                      />
                    </td>
                    <!-- right dots -->
                    <td style="vertical-align:middle;padding-left:10px;">
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"
                      ></span>
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;margin-right:3px;"
                      ></span>
                      <span
                        style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#5b9bd5;"
                      ></span>
                    </td>
                  </tr>
                </table>

                <!-- VERIFY YOUR IDENTITY label -->
                <p
                  style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:2px;color:#3a7dc9;text-transform:uppercase;font-family:Arial,sans-serif;"
                >
                  VERIFY YOUR IDENTITY
                </p>

                <!-- Heading -->
                <p
                  style="margin:0 0 22px;font-size:19px;font-weight:400;color:#111111;line-height:1.45;text-align:center;font-family:Georgia,'Times New Roman',serif;"
                >
                  Enter the following code to finish linking CustomizeCollection.
                </p>

                <!-- Code box -->
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
                  <tr>
                    <td align="center" style="background:#f2f2f2;border-radius:4px;padding:18px 0;">
                      <span
                        style="font-size:38px;font-weight:700;letter-spacing:10px;color:#111111;font-family:Georgia,'Times New Roman',serif;"
                      >
                        ${code}
                      </span>
                    </td>
                  </tr>
                </table>

                <!-- Footer note -->
                <p
                  style="margin:0;font-size:13px;color:#555555;text-align:center;line-height:1.6;font-family:Arial,sans-serif;"
                >
                  Not expecting this email?<br />
                  Contact
                  <a
                    href="mailto:hello@customizecollection.publicvm.com"
                    style="color:#333333;text-decoration:underline;"
                    >customizecollection.publicvm.com</a
                  >
                  if you did not request this code.
                </p>
              </td>
            </tr>

            <!-- BOTTOM BAR -->
            <tr>
              <td align="center" style="background:#f0f0f0;border-top:1px solid #e0e0e0;padding:14px 40px;">
                <p
                  style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#333333;text-transform:uppercase;font-family:Arial,sans-serif;"
                >
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

server.listen(3000, () => console.log('Server running on https://customizecollection.publicvm.com'));

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


// SUB-PRODUCTS LIBRARY
const allOrders = {
    "Saree": [
    { name: "Mundum Neriyathum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711596/Mundum-Neriyathum_mnhu3f.png", price: 450 },
    { name: "Jamdani Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711582/Jamdani_rvnozv.png", price: 1200 },
    { name: "Mekhela Chador", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711591/Mekhela-Chador1_rchtny.png", price: 999 },
    { name: "Mekhela Chador", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711592/Mekhela-Chador2_omqvww.png", price: 1049 },
    { name: "Cape Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711358/Cape-Saree_nmzgvo.png", price: 1150 },
    { name: "Net Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711593/Net-Saree_zbppxd.png", price: 799 },
    { name: "Half Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711629/Half-Saree_o2tk0y.png", price: 1299 },
    { name: "Applique Work Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711372/Applique-Work-Saree_zhrdid.png", price: 999 },
    { name: "Fabric Work Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711365/Fabric-Work-Saree_raibow.png", price: 499 },
    { name: "Fabric Work Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711366/Fabric-Work-Saree1_hpvlwg.png", price: 549 },
    { name: "Silk Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711616/Silk-Saree_bagl39.png", price: 889 },
    { name: "Ready-to-Wear Saree", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711609/Ready-to-Wear-Saree_o1tbek.png", price: 1199 }
    ],
    "Western Short Dresses": [
    { name: "Ruffle Sleeve Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711611/Ruffle-Sleeve-Dress_d5npo1.png", price: 549 },
    { name: "Off-Shoulder Short Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711596/Off-Shoulder-Short-Dress_vyrv9x.png", price: 499 },
    { name: "Puff Sleeve Short Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711607/Puffy-Sleeves-Short-Dress_fereyy.png", price: 599 },
    { name: "Barbie Style Short Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711375/Barbie-Style-Short-Dress_tsvlyg.png", price: 699 },
    { name: "Bodycon Short Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711356/Bodycon-Short-Dress_gfxnfh.png", price: 399 }
    ],
    "Lehenga & Chaniya Choli & Ghagra": [
    { name: "Chaniya Choli", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711365/Chaniya-Choli_up19cj.png", price: 1100 },
    { name: "Ghagra", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711371/Ghagra_yarm11.png", price: 999 },
    { name: "Party Wear Lehenga", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711598/Party-Wear-Lehenga_xcugxz.png", price: 1999 },
    { name: "Bridal Lehenga", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711357/Bridal-Lehenga_fzsxle.png", price: 4500 },
    { name: "Mermaid Or Fish-Cut Lehenga", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711590/Mermaid-Or-Fish-Cut-Lehenga_dlepm5.png", price: 1799 },
    { name: "Party Wear Fish-Cut Lehenga", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711598/Party-Wear-Fish-Cut-Lehenga_chuvc3.png", price: 2864 },
    { name: "Banarasi Lehenga", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711375/Banarasi-Lehenga_dtsdjl.png", price: 2200 }
    ],
    "Gown": [
    { name: "Indo Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711588/Indo-Gown_edvynw.png", price: 1499 },
    { name: "Indo Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711582/Indo-Gown1_kznfdg.png", price: 1549 },
    { name: "Saree Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711612/Saree-Gown_jkaat4.jpg", price: 1599 },
    { name: "Ball Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711374/Ball-Gown_b4ljhn.png", price: 2499 },
    { name: "Mermaid Style Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711590/Mermaid-Style-Gown_ulg3eh.png", price: 1400 },
    { name: "Trail Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711620/Gown-With-Trail_p5q4q3.png", price: 1999 },
    { name: "Off-Shoulder Pleated Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711595/Off-Shoulder-With-Pleated-Gown_quyomw.png", price: 1699 },
    { name: "Big Size Ball Trail Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711376/Big-Size-Ball-Gown-With-Trail_aanpat.png", price: 2999 },
    { name: "A-Line Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711368/A-Line-Gown_bzgkty.png", price: 999 },
    { name: "Asymmetrical Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711372/Asymmetrical-Gown_afrbah.png", price: 1100 },
    { name: "Balloon Sleeve Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711374/Balloon-Sleeve-Gown_bnb5ef.png", price: 1299 },
    { name: "Bohemian Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711356/Bohemian-Gown_ysnz10.png", price: 899 },
    { name: "Cape Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711357/Cape-Gown_yx5a40.png", price: 1250 },
    { name: "Empire Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711364/Empire-Gown_kpcpas.png", price: 1050 },
    { name: "Halter Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711621/Halter-Gown_uoml3a.png", price: 1199 },
    { name: "High Low Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711580/High-Low-Gown_d0dczx.png", price: 1150 },
    { name: "Sheath Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711614/Sheath-Gown_telwpb.png", price: 950 },
    { name: "Slip Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711616/Slip-Gown_t1721z.png", price: 699 },
    { name: "Tea Length Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711699/Tea-Length-Gown_s2njhz.png", price: 1199 },
    { name: "Trumpet Gown", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711702/Trumpet-Gown_b1mjuw.png", price: 1450 }
    ],
    "Palazzo": [
    { name: "Palazzo with Crop Top", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711596/Palazzo-With-Crop-Top_lscjh6.png", price: 799 },
    { name: "Palazzo with Jacket", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711598/Palazzo-With-Jacket_qnpbof.png", price: 1199 },
    { name: "Palazzo with Kurti", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711599/Palazzo-with-Kurti_lnszsu.png", price: 850 },
    { name: "Palazzo with Indo-Western Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711597/Palazzo-with-Indo-Western-Dress_minayw.png", price: 1299 }
    ],
    "Gharara": [
        { name: "Gharara", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711620/Gharara1_owarjo.png", price: 1499 },
    ],
    "Salwar Kameez": [
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711610/Salwar-Kameez1_kifbjr.png", price: 899 },
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711611/Salwar-Kameez2_jfbovl.png", price: 1099 },
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711611/Salwar-Kameez3_bsrc3s.png", price: 999 },
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711611/Salwar-Kameez4_ndiuwh.png", price: 1049 },
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711612/Salwar-Kameez5_b6fulv.png", price: 949 },
        { name: "Salwar Kameez", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711613/Salwar-Kameez6_l3lxqi.png", price: 1149 }
    ],
    "Peplum": [
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711601/Peplum1_tctjz4.png", price: 799 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711601/Peplum2_q300yo.png", price: 849 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711602/Peplum3_uji1st.png", price: 899 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711602/Peplum4_pervly.png", price: 949 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711602/Peplum5_cve9ka.png", price: 999 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711603/Peplum6_wsp4ua.png", price: 949 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711603/Peplum7_g3qn2u.png", price: 899 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711604/Peplum8_c6p8gg.png", price: 849 },
        { name: "Peplum", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711604/Peplum9_qivquo.png", price: 799 }
    ],
    "Anarkali": [
        { name: "Anarkali", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711369/Anarkali1_plnp2l.png", price: 1299 },
        { name: "Anarkali", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711371/Anarkali2_omxboh.png", price: 1349 },
        { name: "Anarkali", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711371/Anarkali3_kgegn5.png", price: 1399 },
        { name: "Anarkali", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711371/Anarkali4_b0r1fk.png", price: 1449 }
    ],
    "Pattu Pavadai": [
        { name: "Pattu Pavadai", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711600/Pattu-Pavadai1_sa0r81.png", price: 699 },
        { name: "Pattu Pavadai", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711601/Pattu-Pavadai2_gamqit.png", price: 749 }
    ],
    "Sharara": [
        { name: "Sharara", price: 2100, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711614/Sharara1_s1rpmv.png" },
        { name: "Flared-Sharara", price: 2100, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711367/Flared-Sharara_e9lmpt.png" }
    ],
    "Kurti": [
        { name: "Short Kurti", price: 299, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711615/Short-Kurti_j7vvok.png" },
        { name: "Short Kurti", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711615/Short-Kurti1_aqbkeh.png" },
        { name: "Short Kurti", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711615/Short-Kurti2_qcqu92.png" },
        { name: "Long Kurti", price: 899, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711587/Long-Kurti_tuto1j.png" },
        { name: "Long Kurti", price: 949, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711589/Long-Kurti1_nrlsjq.png" }
    ],
    "Jumpsuits": [
        { name: "Wedding Wear Jumpsuit", price: 1199, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711698/Wedding-Wear-Jupsuit_ooi7as.png" },
        { name: "Western Style Jumpsuit", price: 599, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711699/Western-Style-Jumpsuit_yhioam.png" },
        { name: "Beach Wear Jumpsuit", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711375/Beach-Wear-Jumpsuit_eksvby.png" }
    ],
    "Blouse Designs": [
        { name: "Blouse Front Neck Design", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711353/Blouse-Front-Neck-Design1_m0bn9d.png" },
        { name: "Blouse Front Neck Design", price: 409, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711353/Blouse-Front-Neck-Design2_a87mjy.png" },
        { name: "Blouse Front Neck Design", price: 419, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711354/Blouse-Front-Neck-Design3_jdoasd.png" },
        { name: "Blouse Front Neck Design", price: 429, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711354/Blouse-Front-Neck-Design4_re5onl.png" },
        { name: "Blouse Front Neck Design", price: 439, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711354/Blouse-Front-Neck-Design5_vcbk5u.png" },
        { name: "Blouse Front Neck Design", price: 449, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711355/Blouse-Front-Neck-Design6_qa1mos.png" },
        { name: "Blouse Front Neck Design", price: 459, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711356/Blouse-Front-Neck-Design7_brwfgq.png" },
        { name: "Blouse Front Neck Design", price: 469, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711355/Blouse-Front-Neck-Design9_afp9nd.png" },
        { name: "Blouse Front Neck Design", price: 479, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711355/Blouse-Front-Neck-Design8_mrvfkk.png" },
        { name: "Blouse Back Neck Design", price: 450, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711376/Blouse-Back-Neck-Design0_y7ih93.png" },
        { name: "Blouse Back Neck Design", price: 460, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711376/Blouse-Back-Neck-Design1_ipyf1z.png" },
        { name: "Blouse Back Neck Design", price: 470, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design2_rojjvu.png" },
        { name: "Blouse Back Neck Design", price: 480, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design3_douthj.png" },
        { name: "Blouse Back Neck Design", price: 490, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design4_puahmy.png" },
        { name: "Blouse Back Neck Design", price: 500, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design5_lmepzh.png" },
        { name: "Blouse Back Neck Design", price: 510, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design6_sqfe1u.png" },
        { name: "Blouse Back Neck Design", price: 520, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design7_z21d4s.png" },
        { name: "Blouse Back Neck Design", price: 530, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design8_fkbdtx.png" },
        { name: "Blouse Back Neck Design", price: 540, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design9_nygcqe.png" },
        { name: "Blouse Back Neck Design", price: 550, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design10_j1dop5.png" },
        { name: "Blouse Back Neck Design", price: 560, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design11_j5coqz.png" },
        { name: "Blouse Back Neck Design", price: 570, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design12_i07rtw.png" },
        { name: "Blouse Back Neck Design", price: 580, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design13_cxilvh.png" },
        { name: "Blouse Back Neck Design", price: 590, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design14_egzfzs.png" },
        { name: "Blouse Back Neck Design", price: 600, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design15_gaiyth.png" },
        { name: "Blouse Back Neck Design", price: 610, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design16_gnpwbd.png" },
        { name: "Blouse Back Neck Design", price: 620, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design17_utdtx1.png" },
        { name: "Blouse Back Neck Design", price: 630, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design18_dkvcrp.png" },
        { name: "Blouse Back Neck Design", price: 640, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711348/Blouse-Back-Neck-Design19_kkyhzf.png" },
        { name: "Blouse Back Neck Design", price: 650, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design20_spehdi.png" },
        { name: "Blouse Back Neck Design", price: 660, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design21_q8h5j7.png" },
        { name: "Blouse Back Neck Design", price: 670, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711349/Blouse-Back-Neck-Design22_hocfze.png" },
        { name: "Blouse Back Neck Design", price: 680, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design23_b9gdba.png" },
        { name: "Blouse Back Neck Design", price: 690, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711350/Blouse-Back-Neck-Design24_q15hlm.png" },
        { name: "Blouse Back Neck Design", price: 700, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design25_meknhl.png" },
        { name: "Blouse Back Neck Design", price: 710, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711351/Blouse-Back-Neck-Design26_nbnanr.png" },
        { name: "Blouse Back Neck Design", price: 720, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design27_tscmtd.png" },
        { name: "Blouse Back Neck Design", price: 730, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design28_qxvs3x.png" },
        { name: "Blouse Back Neck Design", price: 740, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design29_x5euts.png" },
        { name: "Blouse Back Neck Design", price: 750, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design30_hq8yba.png" },
        { name: "Blouse Back Neck Design", price: 760, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design31_nfmwka.png" },
        { name: "Blouse Back Neck Design", price: 770, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design32_gwajfv.png" },
        { name: "Blouse Back Neck Design", price: 780, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711352/Blouse-Back-Neck-Design33_ifclzv.png" },
        { name: "Blouse Back Neck Design", price: 790, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711353/Blouse-Back-Neck-Design34_mukbf9.png" }
    ],
    "Dhoti Sets": [
        { name: "Dhoti With Kurti Set", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711363/Dhoti-With-Kurti-Set_sml1wy.png", price: 999 },
        { name: "Dhoti With Kurti Set", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711363/Dhoti-With-Kurti-Set1_yvjsl1.png", price: 1049 },
        { name: "Dhoti Style Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711361/Dhoti-Style-Dress_y0bual.png", price: 1099 },
        { name: "Dhoti Style Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711361/Dhoti-Style-Dress1_kz2km2.png", price: 1149 },
        { name: "Dhoti Style Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711362/Dhoti-Style-Dress2_qudme0.png", price: 1199 },
    ],
    "Phanek": [
        { name: "Phanek", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711606/Phanek1_s0rlnc.png", price: 499 }
    ],
    "One Piece Frock": [
        { name: "A-Line Frock", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711367/A-Line-Frock_emrnpd.png" },
        { name: "Fit & Flare Frock", price: 549, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711365/Fit-_-Flare-Frock_lf2e6m.png" },
        { name: "Empire Waist Frock", price: 599, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711365/Empire-Waist-Frock_nzur5e.png" },
        { name: "Sheath Frock", price: 450, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711613/Sheath-Frock_eg93sp.png" },
        { name: "Wrap Frock", price: 550, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711698/Wrap-Frock_h6vaz5.png" },
        { name: "Bodycon Frock", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711355/Bodycon-Frock_s0hrmr.png" },
        { name: "Maxi Frock", price: 799, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711589/Maxi-Frock_akwwko.png" },
        { name: "Shirt Frock", price: 599, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711614/Shirt-Frock_dnwff3.png" },
        { name: "Tiered Frock", price: 699, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711701/Tiered-Frock_jqfrkc.png" },
        { name: "Peplum Frock", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711605/Peplum-Frock_mgyzfe.png" },
        { name: "Halter Neck Frock", price: 549, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711579/Halter-Neck-Frock_rfq3tw.png" },
        { name: "Off-Shoulder Frock", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711593/Off-Shoulder-Frock_domwag.png" },
        { name: "Square Neck Frock", price: 450, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711618/Square-Neck-Frock_x8pkyq.png" },
        { name: "Sweetheart Neck Frock", price: 599, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711698/Sweetheart-Neck-Frock_c1wvws.png" },
        { name: "Ball Gown Frock", price: 899, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711373/Ball-Gown-Frock_i6l7er.png" },
        { name: "Asymmetrical Frock", price: 550, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711372/Asymmetrical-Frock_rqp81c.png" },
        { name: "Spaghetti Strap Frock", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711618/Spaghetti-Strap-Frock_mynk1c.png" }
    ],
    "Short Skirts": [
        { name: "Pleated", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711606/Pleated_iugti8.png" },
        { name: "Denim", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711360/Denim_z8g24x.png" },
        { name: "A-line", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711367/A-line_fvmcql.png" },
        { name: "Mini", price: 299, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711592/Mini_qad60y.png" },
        { name: "Tennis", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711700/Tennis_x5ap5f.png" },
        { name: "Wrap", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711698/Wrap_tuwzve.png" },
        { name: "Ruffled", price: 449, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711608/Ruffled_qxyws6.png" },
        { name: "Cargo", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711359/Cargo_ixvdqb.png" },
        { name: "Skater", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711615/Skater_icpkut.png" },
        { name: "Tiered", price: 450, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711700/Tiered_vqpkiv.png" },
        { name: "Flounce", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711367/Flounce_r9akob.png" },
        { name: "Tulip", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711702/Tulip_snvza8.png" },
        { name: "Tulip", price: 429, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711703/Tulip1_e5dfid.png" },
        { name: "Ruched", price: 449, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711608/Ruched_de8ybu.png" },
        { name: "Asymmetrical", price: 429, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711372/Asymmetrical_xojdej.png" },
        { name: "Pleather", price: 599, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711606/Pleather_pgi0va.png" }
    ],
    "Tops": [
        { name: "Knit Sweater", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711583/Knit-Sweater_p5k3o1.png" },
        { name: "Camisole Top", price: 249, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711357/Camisole-Top_pmzzly.png" },
        { name: "Square Neck Top", price: 299, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711698/Square-Neck-Top_dlumcp.png" },
        { name: "Bell Sleeve Top", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711375/Bell-Sleeve-Top_zlzr9o.png" },
        { name: "Smocked Top", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711617/Smocked-Top_lel0w4.png" },
        { name: "Tie Front Top", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711700/Tie-Front-Top_vr4cxd.png" },
        { name: "Asymmetrical Top", price: 329, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711372/Asymmetrical-Top_enfs7g.png" },
        { name: "Cold Shoulder Top", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711359/Cold-Shoulder-Top_inwwyl.png" },
        { name: "Button Down Blouse", price: 449, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711357/Button-Down-Blouse_zxi3e9.png" },
        { name: "Tunic Top", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711697/Tunic-Top_ieifi6.png" },
        { name: "Cape Top", price: 450, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711358/Cape-Top_pnnphi.png" },
        { name: "Layered Top", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711585/Layered-Top_s3xzcs.png" },
        { name: "Mesh Top", price: 299, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711592/Mesh-Top_scxg52.png" },
        { name: "Embroidered Top", price: 499, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711592/Mesh-Top_scxg52.png" },
        { name: "Satin Blouse", price: 449, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711613/Satin-Blouse_rixv9w.png" },
        { name: "Off-Shoulder Blouse", price: 349, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711594/Off-Shoulder-Blouse_vw6vwa.png" },
        { name: "Peasant Top", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711599/Peasant-Top_j8jclc.jpg" },
        { name: "Knot Front Top", price: 299, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711583/Knot-Front-Top_hnihzd.png" },
        { name: "Chiffon Blouse", price: 399, img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711359/Chiffon-Blouse_cxmoca.png" }
    ],
    "Indo Dress": [
        { name: "Indo Western Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711581/indo1_pgrzby.png", price: 999 },
        { name: "Indo Western Dress", img: "https://res.cloudinary.com/dnami0fsz/image/upload/v1781711581/indo2_r1mrqa.png", price: 1049 }
    ]
};
