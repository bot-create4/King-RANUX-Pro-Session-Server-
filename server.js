// server.js – King RANUX Session Server (CommonJS)

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const app = express();
const BRAND = "King RANUX";

// in-memory maps
const readySessions = new Map();      // phone -> base64 session
const sessionRegistry = new Map();    // phone -> { timeout }
const SESSION_TIMEOUT = 90_000;       // 90 seconds

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));   // serve pair.html from root

// 🟢 POST /api/pair – create pairing code & start session
app.post("/api/pair", async (req, res) => {
  try {
    const phone = (req.body.phone || "").toString();
    const cleaned = phone.replace(/\D/g, ""); // digits only

    // basic validation: Sri Lanka style +94 7X...
    if (!cleaned.startsWith("94") || cleaned.length !== 11) {
      return res.json({
        status: false,
        message: "Invalid phone number. Example: +94 7X XXX XXXX",
      });
    }

    // already pairing for this number
    if (sessionRegistry.has(cleaned)) {
      return res.json({
        status: false,
        message:
          "A pairing session already exists for this number. Please wait or try again in a moment.",
      });
    }

    const authDir = path.join(__dirname, "sessions", cleaned);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log("📡 Creating WhatsApp socket for", cleaned);

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: ["Mac OS", "Safari", "10.15.7"], // pair with code
    });

    sock.ev.on("creds.update", saveCreds);

    // timeout: if user never completes linking
    const timeout = setTimeout(() => {
      console.log("⛔ TIMEOUT for", cleaned);
      sessionRegistry.delete(cleaned);
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch {}
    }, SESSION_TIMEOUT);

    sessionRegistry.set(cleaned, { timeout });

    // connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection } = update;

      if (connection === "open") {
        console.log("✨ Paired with", cleaned);

        try {
          // zip session -> base64 string
          const zip = new AdmZip();
          zip.addLocalFolder(authDir);
          const base64Session = zip.toBuffer().toString("base64");

          const jid = cleaned + "@s.whatsapp.net";

          const text =
`🟢 ${BRAND} SESSION_ID

${base64Session}


✔ Pairing Successful!

📌 Copy this SESSION_ID into your bot.
⚠ Do NOT share this with anyone!`;

          // send to same number on WhatsApp
          await sock.sendMessage(jid, { text });

          // store to show on site as well
          readySessions.set(cleaned, base64Session);

          // cleanup registry + timeout
          const rec = sessionRegistry.get(cleaned);
          if (rec) clearTimeout(rec.timeout);
          sessionRegistry.delete(cleaned);

          console.log("🎉 Session generated and sent to chat", cleaned);
        } catch (err) {
          console.error("Error after open for", cleaned, err);
        } finally {
          // OPTIONAL: delete auth folder if you don't want to keep it
          // try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        }
      }

      if (connection === "close") {
        console.log("⚠ Connection closed before success for", cleaned);
        const rec = sessionRegistry.get(cleaned);
        if (rec) clearTimeout(rec.timeout);
        sessionRegistry.delete(cleaned);
      }
    });

    // request pairing code (string)
    const pairingCode = await sock.requestPairingCode(cleaned);
    console.log("🔐 Pairing code for", cleaned, pairingCode);

    return res.json({
      status: true,
      brand: BRAND,
      code: pairingCode,
      message:
        "Open WhatsApp → Linked devices → Link a device → enter this code.",
    });
  } catch (e) {
    console.error(e);
    return res.json({
      status: false,
      message: "Server error. Please try again.",
      error: String(e),
    });
  }
});

// 🟢 GET /api/session?phone=9477xxxxxxx – check if session ready
app.get("/api/session", (req, res) => {
  const cleaned = (req.query.phone || "").toString().replace(/\D/g, "");
  const session = readySessions.get(cleaned);

  if (!session) {
    return res.json({ ready: false });
  }

  // you can delete after first read
  readySessions.delete(cleaned);

  return res.json({
    ready: true,
    brand: BRAND,
    session,
  });
});

// 🟢 Root – serve the UI page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 ${BRAND} Session Server running on port ${PORT}`)
);