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

    // Step 1: Any inbound message → Main menu
    if (session.step === "INIT") {
      await sendWhatsApp(from, waMainMenu());
      session.step = "AWAIT_MAIN";
      return res.sendStatus(200);
    }

    // Step 1b: Main menu button pressed
    if (
      session.step === "AWAIT_MAIN" &&
      msg.type === "interactive" &&
      msg.interactive.button_reply
    ) {
      const btnId = msg.interactive.button_reply.id;
      if (btnId === "book_btn") {
        // Start booking flow: fetch services immediately
        const { data } = await fetchZoho(
          `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`,
          {},
          3,
          session
        );
        const services = data?.response?.returnvalue?.data || [];
        if (!services.length) {
          await sendWhatsApp(
            from,
            waError("No services found. Please try again later.")
          );
          return res.sendStatus(200);
        }
        session.services = services;
        await sendWhatsApp(from, waServiceList(session, services));
        session.step = "AWAIT_SERVICE";
        return res.sendStatus(200);
      }
      if (btnId === "help_btn") {
        session.step = "AWAIT_HELP";
        await sendWhatsApp(from, waHelpMenu());
        return res.sendStatus(200);
      }
      if (btnId === "support_btn") {
        session.step = "AWAIT_SUPPORT";
        await sendWhatsApp(from, waSupportMenu());
        return res.sendStatus(200);
      }
    }

    // Step 1c: Home button pressed (from Help/Support)
    if (
      (session.step === "AWAIT_HELP" || session.step === "AWAIT_SUPPORT") &&
      msg.type === "interactive" &&
      msg.interactive.button_reply?.id === "home_btn"
    ) {
      session.step = "AWAIT_MAIN";
      await sendWhatsApp(from, waMainMenu());
      return res.sendStatus(200);
    }

    // Step 2: Book button pressed
    if (
      session.step === "AWAIT_BOOK" &&
      msg.type === "interactive" &&
      msg.interactive.button_reply?.id === "book_btn"
    ) {
      // Fetch services from Zoho
      const { data } = await fetchZoho(
        `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`,
        {},
        3,
        session
      );
      const services = data?.response?.returnvalue?.data || [];
      if (!services.length) {
        await sendWhatsApp(
          from,
          waError("No services found. Please try again later.")
        );
        return res.sendStatus(200);
      }
      session.services = services;
      await sendWhatsApp(from, waServiceList(session, services));
      session.step = "AWAIT_SERVICE";
      return res.sendStatus(200);
    }

    // Step 3: Service selected
    if (
      session.step === "AWAIT_SERVICE" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const serviceId = msg.interactive.list_reply.id;
      const service = (session.services || []).find((s) => s.id === serviceId);
      if (!service) {
        await sendWhatsApp(from, waError("Invalid service. Please try again."));
        session.step = "AWAIT_BOOK";
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
        service.let_customer_select_staff // <-- check this flag
      ) {
        // Fetch staff details from Zoho
        const staffUrl = `${ZOHO_BASE}/staffs?workspace_id=${WORKSPACE_ID}`;
        const { data } = await fetchZoho(staffUrl, {}, 3, session);
        const allStaffs = data?.response?.returnvalue?.data || [];
        // Filter only assigned staff for this service
        const assignedStaffs = allStaffs.filter((s) =>
          service.assigned_staffs.includes(s.id)
        );
        session.staffs = assignedStaffs;
        session.step = "AWAIT_STAFF";
        await sendWhatsApp(from, {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: "Select a staff member:" },
            action: {
              button: "Choose Staff",
              sections: [
                {
                  title: "Staff",
                  rows: assignedStaffs.map((s) => ({
                    id: `staff_${s.id}`,
                    title: s.name,
                    description: s.email || s.phone || "",
                  })),
                },
              ],
            },
          },
        });
        return res.sendStatus(200);
      }

      // Offer months (current + 2)
      const now = new Date();
      const months = [];
      for (let i = 0; i < 3; ++i) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push({
          id: `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(
            2,
            "0"
          )}`,
          label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
          year: d.getFullYear(),
          month: d.getMonth() + 1,
        });
      }
      session.months = months;
      await sendWhatsApp(from, waMonthList(session, months));
      session.step = "AWAIT_MONTH";
      return res.sendStatus(200);
    }

    // Step 4: Month selected
    if (
      session.step === "AWAIT_MONTH" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const monthId = msg.interactive.list_reply.id;
      const monthObj = (session.months || []).find((m) => m.id === monthId);
      if (!monthObj) {
        await sendWhatsApp(from, waError("Invalid month. Please try again."));
        session.step = "AWAIT_SERVICE";
        return res.sendStatus(200);
      }
      session.selectedMonth = monthObj;
      // Loop dates in month, find available slots
      const { year, month } = monthObj;
      const lastDay = new Date(year, month, 0).getDate();
      const availableDates = [];
      const today = new Date();
      const startDay =
        year === today.getFullYear() && month === today.getMonth() + 1
          ? today.getDate()
          : 1;
      for (let day = startDay; day <= lastDay; ++day) {
        const dateStr = `${String(day).padStart(2, "0")}-${monthObj.label
          .split(" ")[0]
          .substr(0, 3)}-${year}`;
        const slotUrl = `${ZOHO_BASE}/availableslots?service_id=${session.selectedService.id}&selected_date=${dateStr}`;
        const { data } = await fetchZoho(slotUrl, {}, 3, session);
        const slots = data?.response?.returnvalue?.data;
        if (Array.isArray(slots) && slots.length > 0) {
          availableDates.push({
            id: `date_${dateStr}`,
            label: dateStr,
            slots: slots.length,
          });
        }
      }
      session.availableDates = availableDates;
      session.datePage = 0; // pagination index

      if (!availableDates.length) {
        await sendWhatsApp(
          from,
          waError(`No slots in ${monthObj.label}. Choose another month.`)
        );
        session.step = "AWAIT_MONTH";
        return res.sendStatus(200);
      }

      // Show first 9 dates, add "Show more" as 10th row if needed
      const pageSize = 9;
      const pageDates = availableDates.slice(0, pageSize);
      let waMsg = waDateList(session, pageDates, monthObj.label);

      if (availableDates.length > pageSize) {
        waMsg.interactive.action.sections[0].rows.push({
          id: "show_more_dates",
          title: "Show more dates...",
        });
      }

      await sendWhatsApp(from, waMsg);
      session.step = "AWAIT_DATE";
      return res.sendStatus(200);
    }

    // Step 5: Date selected or Show more
    if (
      session.step === "AWAIT_DATE" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const dateId = msg.interactive.list_reply.id;

      // Handle "Show more dates"
      if (dateId === "show_more_dates") {
        const pageSize = 9;
        session.datePage = (session.datePage || 0) + 1;
        const start = session.datePage * pageSize;
        const pageDates = session.availableDates.slice(start, start + pageSize);
        let waMsg = waDateList(session, pageDates, session.selectedMonth.label);

        if (session.availableDates.length > start + pageSize) {
          waMsg.interactive.action.sections[0].rows.push({
            id: "show_more_dates",
            title: "Show more dates...",
          });
        }
        await sendWhatsApp(from, waMsg);
        return res.sendStatus(200);
      }

      const dateObj = (session.availableDates || []).find(
        (d) => d.id === dateId
      );
      if (!dateObj) {
        await sendWhatsApp(from, waError("Invalid date. Please try again."));
        session.step = "AWAIT_MONTH";
        return res.sendStatus(200);
      }
      session.selectedDate = dateObj;
      // Fetch slots for this date
      const slotUrl = `${ZOHO_BASE}/availableslots?service_id=${session.selectedService.id}&selected_date=${dateObj.label}`;
      const { data } = await fetchZoho(slotUrl, {}, 3, session);
      const slots = Array.isArray(data?.response?.returnvalue?.data)
        ? data.response.returnvalue.data
        : [];
      if (!slots.length) {
        await sendWhatsApp(
          from,
          waError("No slots available. Choose another date.")
        );
        session.step = "AWAIT_DATE";
        return res.sendStatus(200);
      }
      session.slots = slots.map((s) => ({
        id: `slot_${dateObj.label}_${s.replace(/:/g, "-")}`,
        label: s,
        time: s,
      }));
      session.slotPage = 0; // pagination index for slots

      // Show first 9 slots, add "Show more" as 10th row if needed
      const slotPageSize = 9;
      const pageSlots = session.slots.slice(0, slotPageSize);
      let waMsg = waSlotList(session, pageSlots, dateObj.label);

      if (session.slots.length > slotPageSize) {
        waMsg.interactive.action.sections[0].rows.push({
          id: "show_more_slots",
          title: "Show more slots...",
        });
      }
      await sendWhatsApp(from, waMsg);
      session.step = "AWAIT_SLOT";
      return res.sendStatus(200);
    }

    // Step 6: Slot selected or Show more
    if (
      session.step === "AWAIT_SLOT" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const slotId = msg.interactive.list_reply.id;

      // Handle "Show more slots"
      if (slotId === "show_more_slots") {
        const slotPageSize = 9;
        session.slotPage = (session.slotPage || 0) + 1;
        const start = session.slotPage * slotPageSize;
        const pageSlots = session.slots.slice(start, start + slotPageSize);
        let waMsg = waSlotList(session, pageSlots, session.selectedDate.label);

        if (session.slots.length > start + slotPageSize) {
          waMsg.interactive.action.sections[0].rows.push({
            id: "show_more_slots",
            title: "Show more slots...",
          });
        }
        await sendWhatsApp(from, waMsg);
        return res.sendStatus(200);
      }

      const slotObj = (session.slots || []).find((s) => s.id === slotId);
      if (!slotObj) {
        await sendWhatsApp(from, waError("Invalid slot. Please try again."));
        session.step = "AWAIT_DATE";
        return res.sendStatus(200);
      }
      session.selectedSlot = slotObj;
      // Prompt for name
      await sendWhatsApp(
        from,
        waTextPrompt(session, "enterFullName", "name_prompt")
      );
      session.step = "AWAIT_NAME";
      session.nameAttempts = 0;
      return res.sendStatus(200);
    }

    // Step 7: Name input
    if (session.step === "AWAIT_NAME" && msg.type === "text") {
      const name = msg.text.body.trim();
      if (!name || name.length > 100) {
        session.nameAttempts = (session.nameAttempts || 0) + 1;
        if (session.nameAttempts >= 3) {
          await sendWhatsApp(from, waError("Invalid name. Booking cancelled."));
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(
          from,
          waTextPrompt(session, "nameInvalid", "name_prompt")
        );
        return res.sendStatus(200);
      }
      session.customerName = name;
      await sendWhatsApp(
        from,
        waTextPrompt(
          "Enter your email address (e.g., user@example.com):",
          "email_prompt"
        )
      );
      session.step = "AWAIT_EMAIL";
      session.emailAttempts = 0;
      return res.sendStatus(200);
    }

    // Step 8: Email input
    if (session.step === "AWAIT_EMAIL" && msg.type === "text") {
      const email = msg.text.body.trim();
      if (!validateEmail(email)) {
        session.emailAttempts = (session.emailAttempts || 0) + 1;
        if (session.emailAttempts >= 3) {
          await sendWhatsApp(
            from,
            waError("Invalid email. Booking cancelled.")
          );
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(
          from,
          waTextPrompt(
            "Email invalid. Please enter again (e.g., user@example.com):",
            "email_prompt"
          )
        );
        return res.sendStatus(200);
      }
      session.customerEmail = email;
      await sendWhatsApp(
        from,
        waTextPrompt(
          "Enter your phone number (e.g., 9xxxxxxxxx or +91xxxxxxxxxx):",
          "phone_prompt"
        )
      );
      session.step = "AWAIT_PHONE";
      session.phoneAttempts = 0;
      return res.sendStatus(200);
    }

    // Step 9: Phone input
    if (session.step === "AWAIT_PHONE" && msg.type === "text") {
      const phone = msg.text.body.trim();
      if (!validatePhone(phone)) {
        session.phoneAttempts = (session.phoneAttempts || 0) + 1;
        if (session.phoneAttempts >= 3) {
          await sendWhatsApp(
            from,
            waError("Invalid phone. Booking cancelled.")
          );
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(
          from,
          waTextPrompt(
            "Phone invalid. Please enter again (e.g., 9xxxxxxxxx or +91xxxxxxxxxx):",
            "phone_prompt"
          )
        );
        return res.sendStatus(200);
      }
      session.customerPhone = phone;

      // --- Build Zoho appointment form-data ---
      const formData = new FormData();
      formData.append("service_id", session.selectedService.id);

      // Dynamically add staff_id, group_id, or resource_id
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
        // Only send group_id if it exists and is a string
        let groupId = session.selectedGroup;
        if (
          !groupId &&
          Array.isArray(session.selectedService.assigned_groups)
        ) {
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

      // Format from_time and to_time as dd-Mmm-yyyy HH:mm:ss
      const dateLabel = session.selectedDate.label; // e.g. 07-Nov-2025
      const slotTime = session.selectedSlot.label; // e.g. 10:30 AM or 10:30
      // Convert slotTime to 24-hour HH:mm:ss
      let [hour, minute] = slotTime.split(":");
      let ampm = "";
      if (minute && minute.includes(" ")) {
        [minute, ampm] = minute.split(" ");
        hour = parseInt(hour, 10);
        if (ampm.toUpperCase() === "PM" && hour < 12) hour += 12;
        if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
      }
      hour = hour.toString().padStart(2, "0");
      minute = minute ? minute.padStart(2, "0") : "00";
      const fromTimeStr = `${dateLabel} ${hour}:${minute}:00`;

      // Calculate to_time based on duration (in minutes)
      let duration = 30;
      if (session.selectedService.duration) {
        const match = session.selectedService.duration.match(/(\d+)/);
        if (match) duration = parseInt(match[1], 10);
      }
      const fromDateObj = new Date(
        `${dateLabel} ${hour}:${minute}:00 GMT+0530`
      );
      const toDateObj = new Date(fromDateObj.getTime() + duration * 60000);
      const toHour = toDateObj.getHours().toString().padStart(2, "0");
      const toMinute = toDateObj.getMinutes().toString().padStart(2, "0");
      const toDay = toDateObj.getDate().toString().padStart(2, "0");
      const toMonth = toDateObj.toLocaleString("en-GB", { month: "short" });
      const toYear = toDateObj.getFullYear();
      const toDateLabel = `${toDay}-${toMonth}-${toYear}`;
      const toTimeStr = `${toDateLabel} ${toHour}:${toMinute}:00`;

      formData.append("from_time", fromTimeStr);
      formData.append("to_time", toTimeStr);
      formData.append("timezone", "Asia/Kolkata");
      formData.append("notes", "Booked via WhatsApp");
      formData.append(
        "customer_details",
        JSON.stringify({
          name: session.customerName,
          email: session.customerEmail,
          phone_number: session.customerPhone,
        })
      );

      // --- Log all booking params before API call ---
      log("Zoho Booking Params", {
        service_id: session.selectedService.id,
        bookingType,
        staff_id: session.selectedService.assigned_staffs?.[0],
        group_id: session.selectedService.assigned_groups?.[0],
        resource_id: session.selectedService.assigned_resources?.[0],
        from_time: fromTimeStr,
        to_time: toTimeStr,
        timezone: "Asia/Kolkata",
        customer_details: {
          name: session.customerName,
          email: session.customerEmail,
          phone_number: session.customerPhone,
        },
        notes: "Booked via WhatsApp",
      });

      // --- Make Zoho appointment API call ---
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

      // --- Parse Zoho appointment response ---
      if (
        zohoData?.response?.status === "success" &&
        zohoData.response.returnvalue?.status === "upcoming"
      ) {
        const appt = zohoData.response.returnvalue;
        await sendWhatsApp(
          from,
          waConfirmation(session, {
            service: appt.service_name || session.selectedService.name,
            date: appt.start_time || session.selectedDate.label,
            time: appt.duration || session.selectedSlot.label,
            ref: appt.booking_id || appt.id || "N/A",
            url: appt.summary_url || appt.appointment_url || "",
          })
        );
        clearSession(from);
      } else {
        const zohoMsg =
          zohoData?.response?.returnvalue?.message ||
          zohoData?.response?.message ||
          "Booking failed. Please try again.";
        await sendWhatsApp(from, waError(session, zohoMsg));
        clearSession(from);
      }
      return res.sendStatus(200);
    }

    // Fallback: always offer Book button
    await sendWhatsApp(from, waBookButton());
    session.step = "AWAIT_BOOK";
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
