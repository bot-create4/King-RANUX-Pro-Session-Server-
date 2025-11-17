/*************************************************************
 *  KING RANUX SESSION SERVER
 *************************************************************/

/* === IMPORTANT FIX FOR RENDER + NODE 18 === */
global.crypto = require("crypto"); // required for Baileys pairing

/* === IMPORTS === */
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

/* === CONFIG === */
const app = express();
const BRAND = "King RANUX";
const SESSION_TIMEOUT = 90_000; // 90s
const sessionRegistry = new Map(); // phone -> timeout

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); // serve pair.html + assets

/* === HELPERS === */
function safeRm(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("Failed to remove dir:", dir, e);
  }
}

/*************************************************************
 *  API: POST /api/pair
 *************************************************************/
app.post("/api/pair", async (req, res) => {
  try {
    const phoneRaw = (req.body.phone || "").toString();
    const cleaned = phoneRaw.replace(/\D/g, ""); // digits only

    if (!cleaned.startsWith("94") || cleaned.length !== 11) {
      return res.json({
        status: false,
        message: "Invalid phone number. Example: +94 7X XXX XXXX",
      });
    }

    if (sessionRegistry.has(cleaned)) {
      return res.json({
        status: false,
        message:
          "A pairing session already exists for this number. Please wait 1 minute and try again.",
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
      browser: ["Mac OS", "Safari", "14.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    const timeout = setTimeout(() => {
      console.log("⛔ TIMEOUT for", cleaned);
      sessionRegistry.delete(cleaned);
      safeRm(authDir);
    }, SESSION_TIMEOUT);

    sessionRegistry.set(cleaned, { timeout });

    /*********************************************************
     *  SOCKET EVENTS
     *********************************************************/
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update || {};

      if (connection === "open") {
        console.log("✨ Paired with", cleaned);

        try {
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

          await sock.sendMessage(jid, { text });

          console.log("🎉 Session sent to WhatsApp chat:", cleaned);
        } catch (err) {
          console.error("Error after connection open for", cleaned, err);
        } finally {
          clearTimeout(timeout);
          sessionRegistry.delete(cleaned);
          safeRm(authDir);
        }
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("⚠ Connection closed:", cleaned, "status:", code || "unknown");
        clearTimeout(timeout);
        sessionRegistry.delete(cleaned);
        if (code && code !== 428) safeRm(authDir);
      }
    });

    /*********************************************************
     *  REQUEST PAIRING CODE
     *********************************************************/
    let pairingCode;
    try {
      pairingCode = await sock.requestPairingCode(cleaned);
    } catch (err) {
      console.error("❌ requestPairingCode failed:", err?.output || err);

      if (err?.output?.statusCode === 428) {
        return res.json({
          status: false,
          message:
            "WhatsApp blocked this pairing request (428). Try again in a few minutes.",
        });
      }

      return res.json({
        status: false,
        message: "Failed to ask WhatsApp for a pairing code. Please try again.",
      });
    }

    console.log("🔐 Pairing code:", pairingCode);

    return res.json({
      status: true,
      brand: BRAND,
      code: pairingCode,
      message:
        "Open WhatsApp → Linked devices → Link a device → Enter code and type this code.",
    });
  } catch (e) {
    console.error("POST /api/pair error:", e);
    return res.json({
      status: false,
      message: "Server error. Please try again.",
    });
  }
});

/*************************************************************
 *  UI ROUTE
 *************************************************************/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
});

/*************************************************************
 *  START SERVER
 *************************************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 King RANUX Session Server running on port ${PORT}`);
});