// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { FormData } from "undici";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import Stripe from "stripe";

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
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // Add this
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // Add this

const stripe = new Stripe(STRIPE_SECRET_KEY);

const ZOHO_BASE = "https://www.zohoapis.in/bookings/v1/json";
const WHATSAPP_API = `https://graph.facebook.com/v17.0/${WHATSAPP_NUMBER_ID}/messages`;
const SESSION_TTL = 15 * 60 * 1000; // 15 min

// In-memory session store (swap for Redis in prod)
const sessions = new Map();

// Load translations
const translations = {
  en: JSON.parse(fs.readFileSync("./en.json", "utf-8")),
  hi: JSON.parse(fs.readFileSync("./hi.json", "utf-8")),
  te: JSON.parse(fs.readFileSync("./te.json", "utf-8")), // Changed from te.json to tel.json
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

function t(session, key, vars = {}) {
  const lang = session.language || "en";
  let text = translations[lang]?.[key] || translations["en"]?.[key] || key;
  // Replace placeholders like {name}
  Object.keys(vars).forEach((k) => {
    text = text.replace(new RegExp(`{${k}}`, "g"), vars[k]);
  });
  return text;
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

// --- WhatsApp Interactive Message Builders ---
function waLanguageSelection() {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: "Please select your preferred language / कृपया अपनी पसंदीदा भाषा चुनें / దయచేసి మీ ఇష్టమైన భాషను ఎంచుకోండి",
      },
      action: {
        button: "Choose Language",
        sections: [
          {
            title: "Languages",
            rows: [
              { id: "lang_en", title: "English", description: "English" },
              { id: "lang_hi", title: "हिंदी", description: "Hindi" },
              { id: "lang_te", title: "తెలుగు", description: "Telugu" },
            ],
          },
        ],
      },
    },
  };
}

function waMainMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "mainMenuWelcome") },
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

function waServiceList(session, services) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text:
          t(session, "selectService") +
          "\n\n👇 " +
          t(session, "tapButtonBelow"),
      },
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

function waMonthList(session, months) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "chooseMonth") },
      action: {
        button: t(session, "selectMonth"),
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

function waDateList(session, dates, monthLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "availableDatesIn", { month: monthLabel }) },
      action: {
        button: t(session, "selectDate"),
        sections: [
          {
            title: t(session, "dates"),
            rows: dates.slice(0, 10).map((d) => ({
              id: d.id,
              title:
                d.label.length > 24 ? d.label.slice(0, 21) + "..." : d.label,
              description: t(session, "slotsAvailable", { count: d.slots }),
            })),
          },
        ],
      },
    },
  };
}

function waSlotList(session, slots, dateLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "availableSlotsOn", { date: dateLabel }) },
      action: {
        button: t(session, "selectSlot"),
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

function waTextPrompt(session, key) {
  return {
    type: "text",
    text: {
      body: t(session, key),
    },
  };
}

function waConfirmation(session, details) {
  return {
    type: "text",
    text: {
      body:
        `✅ ${t(session, "bookingConfirmed")}\n` +
        `${t(session, "service")}: ${details.service}\n` +
        `${t(session, "date")}: ${details.date}\n` +
        `${t(session, "time")}: ${details.time}\n` +
        `${t(session, "reference")}: ${details.ref}\n` +
        (details.url ? `${t(session, "viewDetails")}: ${details.url}` : ""),
    },
  };
}

function waError(session, msgKey) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `❌ ${t(session, msgKey)}` },
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

function waHelpMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: t(session, "helpText"),
      },
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

function waSupportMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: t(session, "supportText"),
      },
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

// Add new utility function for scanning slots
async function findNextAvailableSlots(
  session,
  startDate,
  limit = 3,
  maxDaysToScan = 60
) {
  const slots = [];
  const serviceId = session.selectedService.id;
  let currentDate = new Date(startDate);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + maxDaysToScan);

  while (slots.length < limit && currentDate <= endDate) {
    const dateStr = formatDateForZoho(currentDate);

    // Build URL with staff_id if available
    let slotUrl = `${ZOHO_BASE}/availableslots?service_id=${serviceId}&selected_date=${dateStr}`;
    if (session.selectedStaff) {
      slotUrl += `&staff_id=${session.selectedStaff}`;
    }

    const { data } = await fetchZoho(slotUrl, {}, 3, session);
    const availableSlots = data?.response?.returnvalue?.data;

    if (Array.isArray(availableSlots) && availableSlots.length > 0) {
      for (const timeSlot of availableSlots) {
        if (slots.length >= limit) break;
        slots.push({
          id: `slot_${dateStr}_${timeSlot.replace(/:/g, "-")}`,
          label: `${dateStr} ${timeSlot}`,
          date: dateStr,
          time: timeSlot,
        });
      }
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return {
    slots,
    nextSearchDate: currentDate,
  };
}

function formatDateForZoho(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function waSlotListWithShowMore(session, slots, hasMore) {
  const rows = slots.map((s) => ({
    id: s.id,
    title: s.label.length > 24 ? s.label.slice(0, 21) + "..." : s.label,
  }));

  if (hasMore) {
    rows.push({
      id: "show_more_slots",
      title: t(session, "showMore"),
    });
  }

  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t(session, "availableSlots") },
      action: {
        button: t(session, "selectSlot"),
        sections: [
          {
            title: t(session, "slots"),
            rows,
          },
        ],
      },
    },
  };
}

function waSearchingMessage(session) {
  return {
    type: "text",
    text: {
      body: t(session, "searchingSlots"),
    },
  };
}

// Add payment-related functions
async function createStripePaymentLink(session, service) {
  try {
    const priceInCents = Math.round(service.price * 100); // Convert to cents

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price_data: {
            currency: service.currency?.toLowerCase() || "inr",
            product_data: {
              name: service.name,
              description: `Appointment on ${session.selectedDate.label} at ${session.selectedSlot.time}`,
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      after_completion: {
        type: "redirect",
        redirect: {
          url: `${
            process.env.BASE_URL || "https://yourdomain.com"
          }/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        },
      },
      metadata: {
        session_id: session.id,
        user_phone: session.customerPhone,
        service_id: service.id,
        slot_date: session.selectedDate.label,
        slot_time: session.selectedSlot.time,
        staff_id: session.selectedStaff || "none",
      },
    });

    return paymentLink.url;
  } catch (error) {
    log("Stripe payment link creation error:", error);
    return null;
  }
}

function waPaymentRequired(session, paymentUrl, service) {
  const amount = service.price || 0;
  const currency = service.currency || "INR";

  return {
    type: "text",
    text: {
      body:
        `💳 ${t(session, "paymentRequired")}\n\n` +
        `${t(session, "service")}: ${service.name}\n` +
        `${t(session, "amount")}: ${currency} ${amount}\n` +
        `${t(session, "date")}: ${session.selectedDate.label}\n` +
        `${t(session, "time")}: ${session.selectedSlot.time}\n\n` +
        `${t(session, "paymentLink")}: ${paymentUrl}\n\n` +
        `${t(session, "paymentInstructions")}`,
    },
  };
}

function waPaymentPending(session) {
  return {
    type: "text",
    text: {
      body: t(session, "paymentPending"),
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

    // ===========================
    // 1. LANGUAGE SELECTION
    // ===========================
    if (!session.language) {
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

      // Prompt for language
      await sendWhatsApp(from, waLanguageSelection());
      session.step = "AWAIT_LANGUAGE";
      return res.sendStatus(200);
    }

    // ===========================
    // 2. MAIN MENU
    // ===========================
    if (session.step === "INIT") {
      await sendWhatsApp(from, waMainMenu(session));
      session.step = "AWAIT_MAIN";
      return res.sendStatus(200);
    }

    // ===========================
    // 3. HANDLE MAIN MENU BUTTONS
    // ===========================
    if (
      session.step === "AWAIT_MAIN" &&
      msg.type === "interactive" &&
      msg.interactive.button_reply
    ) {
      const btnId = msg.interactive.button_reply.id;

      if (btnId === "book_btn") {
        // Fetch services from Zoho
        const serviceUrl = `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`;
        const { status, data } = await fetchZoho(serviceUrl, {}, 3, session);

        if (status === 200 && data?.response?.returnvalue?.data?.length) {
          const services = data.response.returnvalue.data;
          session.services = services;
          session.step = "AWAIT_SERVICE";
          const serviceList = waServiceList(session, services);
          await sendWhatsApp(from, serviceList);
          return res.sendStatus(200);
        } else {
          await sendWhatsApp(from, waError(session, "noServices"));
          return res.sendStatus(200);
        }
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

    // ===========================
    // 4. HELP/SUPPORT: HOME BUTTON
    // ===========================
    if (
      (session.step === "AWAIT_HELP" || session.step === "AWAIT_SUPPORT") &&
      msg.type === "interactive" &&
      msg.interactive.button_reply?.id === "home_btn"
    ) {
      session.step = "AWAIT_MAIN";
      await sendWhatsApp(from, waMainMenu(session));
      return res.sendStatus(200);
    }

    // ===========================
    // 5. TRY AGAIN BUTTON
    // ===========================
    if (
      msg.type === "interactive" &&
      msg.interactive.button_reply?.id === "try_again"
    ) {
      session.step = "AWAIT_MAIN";
      await sendWhatsApp(from, waMainMenu(session));
      return res.sendStatus(200);
    }

    // ===========================
    // 6. SERVICE SELECTION
    // ===========================
    if (
      session.step === "AWAIT_SERVICE" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const serviceId = msg.interactive.list_reply.id;
      const service = (session.services || []).find((s) => s.id === serviceId);
      if (!service) {
        await sendWhatsApp(from, waError(session, "invalidService"));
        session.step = "AWAIT_MAIN";
        return res.sendStatus(200);
      }
      session.selectedService = service;

      const stype = (service.service_type || "").toUpperCase();
      if (
        (stype === "APPOINTMENT" ||
          stype === "ONE-ON-ONE" ||
          stype === "ONE TO ONE") &&
        Array.isArray(service.assigned_staffs) &&
        service.assigned_staffs.length > 0 &&
        service.let_customer_select_staff
      ) {
        const staffUrl = `${ZOHO_BASE}/staffs?workspace_id=${WORKSPACE_ID}`;
        const { data } = await fetchZoho(staffUrl, {}, 3, session);
        const allStaffs = data?.response?.returnvalue?.data || [];
        const assignedStaffs = allStaffs.filter((s) =>
          service.assigned_staffs.includes(s.id)
        );
        session.staffs = assignedStaffs;
        session.step = "AWAIT_STAFF";
        await sendWhatsApp(from, waStaffList(session, assignedStaffs));
        return res.sendStatus(200);
      }

      // NEW LOGIC: Immediately search for available slots
      await sendWhatsApp(from, waSearchingMessage(session));

      const today = new Date();
      const { slots, nextSearchDate } = await findNextAvailableSlots(
        session,
        today,
        3,
        60
      );

      if (slots.length === 0) {
        await sendWhatsApp(from, waError(session, "noSlotsAvailable"));
        session.step = "AWAIT_MAIN";
        return res.sendStatus(200);
      }

      session.searchStartDate = nextSearchDate.toISOString();
      session.step = "AWAIT_SLOT";
      await sendWhatsApp(from, waSlotListWithShowMore(session, slots, true));
      return res.sendStatus(200);
    }

    // ===========================
    // 7. STAFF SELECTION
    // ===========================
    if (
      session.step === "AWAIT_STAFF" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const staffId = msg.interactive.list_reply.id.replace("staff_", "");
      session.selectedStaff = staffId;

      // NEW LOGIC: Immediately search for available slots
      await sendWhatsApp(from, waSearchingMessage(session));

      const today = new Date();
      const { slots, nextSearchDate } = await findNextAvailableSlots(
        session,
        today,
        3,
        60
      );

      if (slots.length === 0) {
        await sendWhatsApp(from, waError(session, "noSlotsAvailable"));
        session.step = "AWAIT_MAIN";
        return res.sendStatus(200);
      }

      session.searchStartDate = nextSearchDate.toISOString();
      session.step = "AWAIT_SLOT";
      await sendWhatsApp(from, waSlotListWithShowMore(session, slots, true));
      return res.sendStatus(200);
    }

    // ===========================
    // 8. SLOT SELECTION (NEW LOGIC)
    // ===========================
    if (
      session.step === "AWAIT_SLOT" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const slotId = msg.interactive.list_reply.id;

      // Handle "Show More" request
      if (slotId === "show_more_slots") {
        await sendWhatsApp(from, waSearchingMessage(session));

        const startDate = new Date(session.searchStartDate);
        const { slots, nextSearchDate } = await findNextAvailableSlots(
          session,
          startDate,
          3,
          60
        );

        if (slots.length === 0) {
          await sendWhatsApp(from, waError(session, "noMoreSlots"));
          session.step = "AWAIT_MAIN";
          return res.sendStatus(200);
        }

        session.searchStartDate = nextSearchDate.toISOString();
        await sendWhatsApp(from, waSlotListWithShowMore(session, slots, true));
        return res.sendStatus(200);
      }

      // User selected a specific slot
      const [, dateStr, timeStr] = slotId.match(/slot_(.+?)_(.+)/) || [];
      if (!dateStr || !timeStr) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        return res.sendStatus(200);
      }

      session.selectedSlot = {
        id: slotId,
        label: timeStr.replace(/-/g, ":"),
        date: dateStr,
        time: timeStr.replace(/-/g, ":"),
      };
      session.selectedDate = { label: dateStr };

      await sendWhatsApp(from, waTextPrompt(session, "enterName"));
      session.step = "AWAIT_NAME";
      session.nameAttempts = 0;
      return res.sendStatus(200);
    }

    // ===========================
    // 9. NAME INPUT
    // ===========================
    if (session.step === "AWAIT_NAME" && msg.type === "text") {
      const name = msg.text.body.trim();
      if (!name || name.length > 100) {
        session.nameAttempts = (session.nameAttempts || 0) + 1;
        if (session.nameAttempts >= 3) {
          await sendWhatsApp(from, waError(session, "bookingCancelled"));
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(from, waTextPrompt(session, "invalidName"));
        return res.sendStatus(200);
      }
      session.customerName = name;
      await sendWhatsApp(from, waTextPrompt(session, "enterEmail"));
      session.step = "AWAIT_EMAIL";
      session.emailAttempts = 0;
      return res.sendStatus(200);
    }

    // ===========================
    // 10. EMAIL INPUT
    // ===========================
    if (session.step === "AWAIT_EMAIL" && msg.type === "text") {
      const email = msg.text.body.trim();
      if (!validateEmail(email)) {
        session.emailAttempts = (session.emailAttempts || 0) + 1;
        if (session.emailAttempts >= 3) {
          await sendWhatsApp(from, waError(session, "bookingCancelled"));
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(from, waTextPrompt(session, "invalidEmail"));
        return res.sendStatus(200);
      }
      session.customerEmail = email;
      await sendWhatsApp(from, waTextPrompt(session, "enterPhone"));
      session.step = "AWAIT_PHONE";
      session.phoneAttempts = 0;
      return res.sendStatus(200);
    }

    // ===========================
    // 11. PHONE INPUT & BOOKING
    // ===========================
    if (session.step === "AWAIT_PHONE" && msg.type === "text") {
      const phone = msg.text.body.trim();
      if (!validatePhone(phone)) {
        session.phoneAttempts = (session.phoneAttempts || 0) + 1;
        if (session.phoneAttempts >= 3) {
          await sendWhatsApp(from, waError(session, "bookingCancelled"));
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(from, waTextPrompt(session, "invalidPhone"));
        return res.sendStatus(200);
      }
      session.customerPhone = phone;

      // Check if service requires payment
      const service = session.selectedService;
      const requiresPayment = service.price && service.price > 0;

      if (requiresPayment) {
        // Create Stripe payment link
        const paymentUrl = await createStripePaymentLink(session, service);

        if (!paymentUrl) {
          await sendWhatsApp(from, waError(session, "paymentLinkFailed"));
          clearSession(from);
          return res.sendStatus(200);
        }

        // Store payment URL and mark as awaiting payment
        session.paymentUrl = paymentUrl;
        session.step = "AWAIT_PAYMENT";

        await sendWhatsApp(
          from,
          waPaymentRequired(session, paymentUrl, service)
        );
        return res.sendStatus(200);
      }

      // If no payment required, proceed with direct booking
      await createZohoAppointment(session, from);
      return res.sendStatus(200);
    }

    // ===========================
    // 12. PAYMENT CONFIRMATION CHECK
    // ===========================
    if (session.step === "AWAIT_PAYMENT" && msg.type === "text") {
      const userText = msg.text.body.trim().toLowerCase();

      // Check if user is asking about payment status
      if (
        userText.includes("paid") ||
        userText.includes("completed") ||
        userText.includes("done")
      ) {
        // Verify payment status with Stripe
        const paymentVerified = await verifyStripePayment(session);

        if (paymentVerified) {
          await createZohoAppointment(session, from);
          return res.sendStatus(200);
        } else {
          await sendWhatsApp(from, waPaymentPending(session));
          return res.sendStatus(200);
        }
      }

      // If user sends any other message, remind them about payment
      await sendWhatsApp(from, waPaymentPending(session));
      return res.sendStatus(200);
    }

    // ===========================
    // FALLBACK
    // ===========================
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

async function verifyStripePayment(session) {
  try {
    // Search for successful payments matching this session
    const payments = await stripe.checkout.sessions.list({
      limit: 10,
    });

    for (const payment of payments.data) {
      if (
        payment.metadata?.session_id === session.id &&
        payment.payment_status === "paid"
      ) {
        session.stripePaymentId = payment.id;
        session.stripePaymentIntentId = payment.payment_intent;
        return true;
      }
    }

    return false;
  } catch (error) {
    log("Stripe payment verification error:", error);
    return false;
  }
}

async function createZohoAppointment(session, userPhone) {
  const formData = new FormData();
  formData.append("service_id", session.selectedService.id);

  const stype = (session.selectedService.service_type || "").toUpperCase();
  let bookingType = "";

  if (
    (stype === "APPOINTMENT" ||
      stype === "ONE-ON-ONE" ||
      stype === "ONE TO ONE") &&
    Array.isArray(session.selectedService.assigned_staffs) &&
    session.selectedService.assigned_staffs.length > 0
  ) {
    const staffId =
      session.selectedStaff || session.selectedService.assigned_staffs?.[0];
    if (staffId) {
      formData.append("staff_id", staffId);
      bookingType = "staff";
    }
  }

  if (
    stype === "GROUP" ||
    stype === "GROUP BOOKING" ||
    stype === "COLLECTIVE"
  ) {
    let groupId = session.selectedGroup;
    if (!groupId && Array.isArray(session.selectedService.assigned_groups)) {
      const firstGroup = session.selectedService.assigned_groups[0];
      groupId = typeof firstGroup === "object" ? firstGroup.id : firstGroup;
    }
    if (groupId) {
      formData.append("group_id", groupId);
      bookingType = "group";
    }
  }

  if (
    stype === "RESOURCE" &&
    Array.isArray(session.selectedService.assigned_resources) &&
    session.selectedService.assigned_resources.length > 0
  ) {
    formData.append(
      "resource_id",
      session.selectedService.assigned_resources[0]
    );
    bookingType = "resource";
  }

  const dateLabel = session.selectedDate.label;
  const slotTime = session.selectedSlot.time;

  // Parse time - handle both "14:00" and "02:00 PM" formats
  let hour, minute;
  const timeMatch = slotTime.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);

  if (!timeMatch) {
    log("Invalid time format:", slotTime);
    await sendWhatsApp(userPhone, waError(session, "bookingFailed"));
    clearSession(userPhone);
    return;
  }

  hour = parseInt(timeMatch[1], 10);
  minute = timeMatch[2];
  const ampm = timeMatch[3]?.toUpperCase();

  // Convert to 24-hour format if AM/PM is present
  if (ampm) {
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }

  hour = hour.toString().padStart(2, "0");
  const fromTimeStr = `${dateLabel} ${hour}:${minute}:00`;

  // Calculate end time
  let duration = 30;
  if (session.selectedService.duration) {
    const match = session.selectedService.duration.match(/(\d+)/);
    if (match) duration = parseInt(match[1], 10);
  }

  // Create proper Date object for IST timezone
  const [day, month, year] = dateLabel.split("-");
  const monthIndex = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(month);
  const fromDateObj = new Date(
    year,
    monthIndex,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    0
  );

  const toDateObj = new Date(fromDateObj.getTime() + duration * 60000);
  const toHour = toDateObj.getHours().toString().padStart(2, "0");
  const toMinute = toDateObj.getMinutes().toString().padStart(2, "0");
  const toDay = toDateObj.getDate().toString().padStart(2, "0");
  const toMonthName = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][toDateObj.getMonth()];
  const toYear = toDateObj.getFullYear();
  const toTimeStr = `${toDay}-${toMonthName}-${toYear} ${toHour}:${toMinute}:00`;

  formData.append("from_time", fromTimeStr);
  formData.append("to_time", toTimeStr);
  formData.append("timezone", "Asia/Kolkata");

  let notes = "Booked via WhatsApp";
  if (session.stripePaymentId) {
    notes += ` | Payment ID: ${session.stripePaymentId}`;
  }
  formData.append("notes", notes);

  formData.append(
    "customer_details",
    JSON.stringify({
      name: session.customerName,
      email: session.customerEmail,
      phone_number: session.customerPhone,
    })
  );

  log("Zoho Booking Params", {
    service_id: session.selectedService.id,
    bookingType,
    staff_id: session.selectedStaff,
    from_time: fromTimeStr,
    to_time: toTimeStr,
    timezone: "Asia/Kolkata",
    customer_details: {
      name: session.customerName,
      email: session.customerEmail,
      phone_number: session.customerPhone,
    },
    payment_id: session.stripePaymentId || "none",
    notes,
  });

  const zohoToken = await getSessionZohoToken(session);
  const zohoResp = await fetch(`${ZOHO_BASE}/appointment`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${zohoToken}`,
    },
    body: formData,
  });
  const zohoText = await zohoResp.text();
  let zohoData;
  try {
    zohoData = JSON.parse(zohoText.trim());
  } catch (err) {
    log("Zoho JSON.parse ERROR", err.message, "Raw Text:", zohoText);
    zohoData = {};
  }
  log("Zoho appointment", zohoResp.status, JSON.stringify(zohoData));

  if (
    zohoData?.response?.status === "success" &&
    zohoData.response.returnvalue?.status === "upcoming"
  ) {
    const appt = zohoData.response.returnvalue;
    await sendWhatsApp(
      userPhone,
      waConfirmation(session, {
        service: appt.service_name || session.selectedService.name,
        date: appt.start_time || session.selectedDate.label,
        time: appt.duration || session.selectedSlot.time,
        ref: appt.booking_id || appt.id || "N/A",
        url: appt.summary_url || appt.appointment_url || "",
      })
    );
    clearSession(userPhone);
  } else {
    await sendWhatsApp(userPhone, waError(session, "bookingFailed"));
    clearSession(userPhone);
  }
}
