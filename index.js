// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { FormData } from "undici";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ---------------------
// Environment variables
// ---------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ZOHO_TOKEN = process.env.ZOHO_TOKEN;
const WHATSAPP_NUMBER_ID = process.env.WHATSAPP_NUMBER_ID;
const WORKSPACE_ID = process.env.WORKSPACE_ID;
const PORT = process.env.PORT || 3000;

const ZOHO_BASE = "https://www.zohoapis.in/bookings/v1/json";
const WHATSAPP_API = `https://graph.facebook.com/v17.0/${WHATSAPP_NUMBER_ID}/messages`;
const SESSION_TTL = 15 * 60 * 1000; // 15 min

// In-memory session store (swap for Redis in prod)
const sessions = new Map();

// Load translations
const translations = {
  en: JSON.parse(fs.readFileSync("en.json", "utf8")),
  hi: JSON.parse(fs.readFileSync("hi.json", "utf8")),
  te: JSON.parse(fs.readFileSync("tel.json", "utf8")),
};

// --- Utility Functions ---
function log(...args) {
  // Redact tokens
  const safeArgs = args.map((a) =>
    typeof a === "string"
      ? a.replace(
          /(Zoho-oauthtoken|Bearer)\s+[A-Za-z0-9\-_\.]+/g,
          "$1 [REDACTED]"
        )
      : a
  );
  console.log(...safeArgs);
}

function getSession(user) {
  let session = sessions.get(user);
  if (!session || Date.now() - session.updated > SESSION_TTL) {
    session = { id: uuidv4(), step: "INIT", data: {}, updated: Date.now() };
    sessions.set(user, session);
  }
  session.updated = Date.now();
  return session;
}

function clearSession(user) {
  sessions.delete(user);
}

function validateEmail(email) {
  // RFC5322-lite
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function formatDate(date) {
  // DD-MMM-YYYY
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(time24) {
  // "14:00" -> "02:00 PM"
  const [h, m] = time24.split(":");
  const date = new Date();
  date.setHours(Number(h), Number(m));
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

async function getSessionZohoToken(session) {
  // If token exists and is less than 50 minutes old, reuse it
  if (
    session.zohoToken &&
    session.zohoTokenTime &&
    Date.now() - session.zohoTokenTime < 50 * 60 * 1000
  ) {
    return session.zohoToken;
  }
  // Otherwise, fetch new token and cache it
  const refresh_token =
    "1000.91875743c0b7e6f959395937ee30da9e.c34a592d113ae37d2e8736718d590cca";
  const client_id = "1000.Q2XXQN7UNWP5L2F86ZVUFRSK1VEA5V";
  const client_secret = "5fc3eba15a1312ce15056c953027b2b314b6afe2b3";
  const url = `https://accounts.zoho.in/oauth/v2/token?refresh_token=${refresh_token}&client_id=${client_id}&client_secret=${client_secret}&grant_type=refresh_token`;

  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();
  log("Zoho AccessToken Response", resp.status, JSON.stringify(data));
  session.zohoToken = data.access_token;
  session.zohoTokenTime = Date.now();
  return data.access_token;
}

// Update fetchZoho to use the session token
async function fetchZoho(url, opts = {}, retries = 3, session = null) {
  try {
    const zohoToken = session
      ? await getSessionZohoToken(session)
      : await getZohoAccessToken();
    const resp = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Zoho-oauthtoken ${zohoToken}`,
      },
    });
    if (resp.status === 429 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000 * (4 - retries)));
      return fetchZoho(url, opts, retries - 1, session);
    }
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { parseError: true, raw: text };
    }
    log("Zoho", url, resp.status, JSON.stringify(data));
    return { status: resp.status, data };
  } catch (err) {
    log("Zoho fetch error", err);
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 1000 * (4 - retries)));
      return fetchZoho(url, opts, retries - 1, session);
    }
    throw err;
  }
}

async function sendWhatsApp(to, payload) {
  const body = {
    messaging_product: "whatsapp",
    to,
    ...payload,
  };
  const resp = await fetch(WHATSAPP_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  log("WA send", resp.status, text);
  return resp.status < 300;
}

// Translation helper
function t(session, key, params = {}) {
  const lang = session.language || "en";
  let text = translations[lang][key] || translations["en"][key] || key;
  Object.entries(params).forEach(([k, v]) => {
    text = text.replace(`{${k}}`, v);
  });
  return text;
}

// Book button
function waBookButton(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "mainMenu") },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "book_btn", title: t(session, "book") },
          },
        ],
      },
    },
  };
}

// Service list
function waServiceList(session, services) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "selectService") },
      action: {
        button: t(session, "chooseService"),
        sections: [
          {
            title: t(session, "services"),
            rows: services.slice(0, 10).map((s) => ({
              id: s.id,
              title: s.name.length > 24 ? s.name.slice(0, 21) + "..." : s.name,
              description: s.duration || s.service_type,
            })),
          },
        ],
      },
    },
  };
}

// Staff selection
function waStaffList(session, staffs) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "selectStaff") },
      action: {
        button: t(session, "chooseStaff"),
        sections: [
          {
            title: t(session, "staff"),
            rows: staffs.map((s) => ({
              id: `staff_${s.id}`,
              title: s.name,
              description: s.email || s.phone || "",
            })),
          },
        ],
      },
    },
  };
}

// Month list
function waMonthList(session, months) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "chooseMonth") },
      action: {
        button: t(session, "chooseMonth"),
        sections: [
          {
            title: t(session, "months"),
            rows: months.slice(0, 10).map((m) => ({
              id: m.id,
              title:
                m.label.length > 24 ? m.label.slice(0, 21) + "..." : m.label,
            })),
          },
        ],
      },
    },
  };
}

// Date list
function waDateList(session, dates, monthLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "chooseDate", { month: monthLabel }) },
      action: {
        button: t(session, "chooseDate", { month: monthLabel }),
        sections: [
          {
            title: t(session, "dates"),
            rows: dates.slice(0, 10).map((d) => ({
              id: d.id,
              title:
                d.label.length > 24 ? d.label.slice(0, 21) + "..." : d.label,
              description: `${d.slots} ${t(session, "slots")}`,
            })),
          },
        ],
      },
    },
  };
}

// Slot list
function waSlotList(session, slots, dateLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "chooseSlot", { date: dateLabel }) },
      action: {
        button: t(session, "chooseSlot", { date: dateLabel }),
        sections: [
          {
            title: t(session, "slots"),
            rows: slots.slice(0, 10).map((s) => ({
              id: s.id,
              title:
                s.label.length > 24 ? s.label.slice(0, 21) + "..." : s.label,
            })),
          },
        ],
      },
    },
  };
}

// Text prompt
function waTextPrompt(session, key, id) {
  return {
    type: "text",
    text: {
      body: t(session, key),
    },
  };
}

// Confirmation
function waConfirmation(session, details) {
  return {
    type: "text",
    text: {
      body:
        `${t(session, "bookingConfirmed")}\n` +
        `${t(session, "service")}: ${details.service}\n` +
        `${t(session, "date")}: ${details.date}\n` +
        `${t(session, "time")}: ${details.time}\n` +
        `${t(session, "ref")}: ${details.ref}\n` +
        (details.url ? `${t(session, "viewDetails")}: ${details.url}` : ""),
    },
  };
}

// Error
function waError(session, key) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `❌ ${t(session, key)}` },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "try_again", title: t(session, "tryAgain") },
          },
        ],
      },
    },
  };
}

// Main menu
function waMainMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "mainMenu") },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "book_btn", title: t(session, "book") },
          },
          {
            type: "reply",
            reply: { id: "help_btn", title: t(session, "help") },
          },
          {
            type: "reply",
            reply: { id: "support_btn", title: t(session, "support") },
          },
        ],
      },
    },
  };
}

// Help menu
function waHelpMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "howToBook") },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "home_btn", title: t(session, "home") },
          },
        ],
      },
    },
  };
}

// Support menu
function waSupportMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "supportText") },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "home_btn", title: t(session, "home") },
          },
        ],
      },
    },
  };
}

// ---------------------
// Webhook verification
// ---------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------------------
// Handle incoming webhook events
// ---------------------
app.post("/webhook", async (req, res) => {
  try {
    log("INBOUND", JSON.stringify(req.body));
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;
    const msgId = msg.id;
    const session = getSession(from);

    // Idempotency: skip duplicate message id
    if (session.lastMsgId === msgId) return res.sendStatus(200);
    session.lastMsgId = msgId;

    // 1. Language selection
    if (!session.language) {
      // If user is replying to language selection
      if (
        session.step === "AWAIT_LANGUAGE" &&
        msg.type === "interactive" &&
        msg.interactive.list_reply
      ) {
        const langId = msg.interactive.list_reply.id.replace("lang_", "");
        session.language = langId;
        session.step = "AWAIT_MAIN";
        await sendWhatsApp(from, waMainMenu(session));
        return res.sendStatus(200);
      }
      // Otherwise, prompt for language selection
      await sendWhatsApp(from, {
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: translations["en"].chooseLanguage },
          action: {
            button: "Choose Language",
            sections: [
              {
                title: "Languages",
                rows: [
                  { id: "lang_en", title: translations["en"].languages.en },
                  { id: "lang_hi", title: translations["en"].languages.hi },
                  { id: "lang_te", title: translations["en"].languages.te },
                ],
              },
            ],
          },
        },
      });
      session.step = "AWAIT_LANGUAGE";
      return res.sendStatus(200);
    }

    // 2. Main menu (only if step is INIT or AWAIT_MAIN)
    if (session.step === "INIT" || session.step === "AWAIT_MAIN") {
      await sendWhatsApp(from, waMainMenu(session));
      session.step = "AWAIT_MAIN";
      return res.sendStatus(200);
    }

    // 3. Handle main menu button presses
    if (
      session.step === "AWAIT_MAIN" &&
      msg.type === "interactive" &&
      msg.interactive.button_reply
    ) {
      const btnId = msg.interactive.button_reply.id;
      if (btnId === "book_btn") {
        session.step = "AWAIT_SERVICE";
        await sendWhatsApp(from, waTextPrompt(session, "selectService"));
        return res.sendStatus(200);
      }
      if (btnId === "help_btn") {
        session.step = "AWAIT_HELP";
        await sendWhatsApp(from, waHelpMenu(session));
        return res.sendStatus(200);
      }
      if (btnId === "support_btn") {
        session.step = "AWAIT_SUPPORT";
        await sendWhatsApp(from, waSupportMenu(session));
        return res.sendStatus(200);
      }
    }

    // 4. Help/Support: Home button returns to main menu
    if (
      (session.step === "AWAIT_HELP" || session.step === "AWAIT_SUPPORT") &&
      msg.type === "interactive" &&
      msg.interactive.button_reply?.id === "home_btn"
    ) {
      session.step = "AWAIT_MAIN";
      await sendWhatsApp(from, waMainMenu(session));
      return res.sendStatus(200);
    }

    // 5. Service selection (after Book)
    if (
      session.step === "AWAIT_SERVICE" &&
      msg.type === "text" &&
      msg.text?.body
    ) {
      // Here you would handle the service selection, e.g.:
      // session.data.service = msg.text.body;
      // session.step = "NEXT_BOOKING_STEP";
      // await sendWhatsApp(from, waTextPrompt(session, "enterName"));
      // return res.sendStatus(200);

      // For now, just echo back the selected service and go to main menu
      await sendWhatsApp(from, {
        type: "text",
        text: { body: t(session, "service") + ": " + msg.text.body },
      });
      session.step = "AWAIT_MAIN";
      await sendWhatsApp(from, waMainMenu(session));
      return res.sendStatus(200);
    }

    // Fallback: always return to main menu
    session.step = "AWAIT_MAIN";
    await sendWhatsApp(from, waMainMenu(session));
    return res.sendStatus(200);
  } catch (err) {
    log("Webhook error", err.stack);
    res.sendStatus(500);
  }
});

// --- Debug route (dev only) ---
app.get("/debug/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(session);
});

// --- Start server ---
app.listen(PORT, () => log(`🚀 Webhook running on port ${PORT}`));
