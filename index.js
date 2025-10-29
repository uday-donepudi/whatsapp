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
  // Trim and convert to lowercase
  email = email.trim().toLowerCase();

  // RFC5322-lite with stricter rules
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

  if (!emailRegex.test(email)) {
    return false;
  }

  // Additional checks
  const [localPart, domain] = email.split("@");

  // Local part (before @) should be 1-64 characters
  if (!localPart || localPart.length > 64) {
    return false;
  }

  // Domain should have at least one dot
  if (!domain || !domain.includes(".")) {
    return false;
  }

  // Domain should not start or end with dot or hyphen
  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.startsWith("-") ||
    domain.endsWith("-")
  ) {
    return false;
  }

  // Top-level domain should be at least 2 characters
  const tld = domain.split(".").pop();
  if (!tld || tld.length < 2) {
    return false;
  }

  return true;
}

function validatePhone(phone) {
  const digits = phone.replace(/\D/g, "");

  // Phone number must be exactly 10 digits
  if (digits.length !== 10) {
    return false;
  }

  // Must start with 6, 7, 8, or 9 (valid Indian mobile prefixes)
  return /^[6-9]\d{9}$/.test(digits);
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
    "1000.340d5fb39304040e893888f8c72bc51d.918dcf51e198f24c0342240e2890573f";
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
              { id: "lang_en", title: "English" },
              { id: "lang_hi", title: "हिंदी" },
              { id: "lang_te", title: "తెలుగు" },
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
            reply: {
              id: "my_bookings_btn",
              title: t(session, "myBookings"),
            },
          },
          {
            type: "reply",
            reply: {
              id: "help_btn",
              title: t(session, "help"),
            },
          },
        ],
      },
    },
  };
}

// Add the My Bookings submenu function
function waMyBookingsMenu(session) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t(session, "myBookingsMenu") },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "book_new_btn",
              title: t(session, "bookAppointment"),
            },
          },
          {
            type: "reply",
            reply: { id: "reschedule_btn", title: t(session, "reschedule") },
          },
          {
            type: "reply",
            reply: { id: "cancel_btn", title: t(session, "cancel") },
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
  let slotCounter = 0;

  // Determine which staff/group/resource to use
  const serviceType = (
    session.selectedService.service_type || ""
  ).toUpperCase();
  let staffId = session.selectedStaff;
  let groupId = session.selectedGroup;

  // If no staff selected, use default from service
  if (!staffId && !groupId) {
    if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
      groupId = session.selectedService.assigned_groups?.[0]?.id;
    } else {
      staffId = session.selectedService.assigned_staffs?.[0];
    }
  }

  // Track which date we're currently showing slots from and the index
  if (!session.currentSlotDate) {
    session.currentSlotDate = formatDateForZoho(currentDate);
    session.currentDateSlotIndex = 0;
    session.allSlotsForCurrentDate = null;
  }

  // If we have a stored date, start from that date
  if (session.currentSlotDate) {
    const [day, month, year] = session.currentSlotDate.split("-");
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
    currentDate = new Date(year, monthIndex, parseInt(day));
  }

  while (slots.length < limit && currentDate <= endDate) {
    const dateStr = formatDateForZoho(currentDate);

    // If we're on a new date or don't have slots cached, fetch them
    if (
      session.currentSlotDate !== dateStr ||
      !session.allSlotsForCurrentDate
    ) {
      let slotUrl = `${ZOHO_BASE}/availableslots?service_id=${serviceId}&selected_date=${dateStr}`;

      // Add staff_id or group_id based on service type
      if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
        if (groupId) {
          slotUrl += `&group_id=${groupId}`;
        }
      } else {
        if (staffId) {
          slotUrl += `&staff_id=${staffId}`;
        }
      }

      console.log("Fetching slots from Zoho:", slotUrl);
      const { data } = await fetchZoho(slotUrl, {}, 3, session);
      const availableSlots = data?.response?.returnvalue?.data;

      if (Array.isArray(availableSlots) && availableSlots.length > 0) {
        // Cache all slots for this date
        session.allSlotsForCurrentDate = availableSlots;
        session.currentSlotDate = dateStr;
        session.currentDateSlotIndex = 0;
      } else {
        // No slots for this date, move to next day
        session.allSlotsForCurrentDate = null;
        currentDate.setDate(currentDate.getDate() + 1);
        session.currentSlotDate = formatDateForZoho(currentDate);
        session.currentDateSlotIndex = 0;
        continue;
      }
    }

    // Get slots from current date starting from current index
    const startIndex = session.currentDateSlotIndex || 0;
    const remainingSlots = session.allSlotsForCurrentDate.slice(startIndex);

    // Add slots up to the limit
    for (let i = 0; i < remainingSlots.length && slots.length < limit; i++) {
      const timeSlot = remainingSlots[i];
      const uniqueId = `slot_${slotCounter}_${dateStr}_${timeSlot.replace(
        /[:\s]/g,
        "-"
      )}`;
      slotCounter++;

      slots.push({
        id: uniqueId,
        label: `${dateStr} ${timeSlot}`,
        date: dateStr,
        time: timeSlot,
      });

      // Update the index for this date
      session.currentDateSlotIndex = startIndex + i + 1;
    }

    // If we've shown all slots for this date, move to next date
    if (session.currentDateSlotIndex >= session.allSlotsForCurrentDate.length) {
      session.allSlotsForCurrentDate = null;
      session.currentDateSlotIndex = 0;
      currentDate.setDate(currentDate.getDate() + 1);
      session.currentSlotDate = formatDateForZoho(currentDate);
    } else {
      // Still have more slots in current date, so stop here
      break;
    }
  }

  return {
    slots,
    nextSearchDate: currentDate,
    hasMore: slots.length === limit, // Indicate if there might be more slots
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

// Add new helper function for searching appointments message
function waSearchingAppointments(session) {
  return {
    type: "text",
    text: {
      body: "🔍 " + t(session, "searchingAppointments"),
    },
  };
}

// Add payment-related functions
async function createStripePaymentLink(session, service) {
  if (!stripe) {
    log("Stripe not configured, skipping payment");
    return null;
  }

  try {
    const amountInPaise = Math.round((service.price || 0) * 100);

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price_data: {
            currency: (service.currency || "INR").toLowerCase(),
            product_data: {
              name: service.name,
              description: `Appointment - ${service.name} on ${session.selectedDate?.label} at ${session.selectedSlot?.time}`,
            },
            unit_amount: amountInPaise,
          },
          quantity: 1,
        },
      ],
      metadata: {
        session_id: session.id,
        service_id: service.id,
        customer_name: session.customerName || "",
        customer_email: session.customerEmail || "",
      },
      after_completion: {
        type: "redirect",
        redirect: {
          url: `${
            process.env.BASE_URL || "https://example.com"
          }/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        },
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
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text:
          `💳 ${t(session, "paymentRequired")}\n\n` +
          `${t(session, "service")}: ${service.name}\n` +
          `${t(session, "amount")}: ${currency} ${amount}\n` +
          `${t(session, "date")}: ${session.selectedDate.label}\n` +
          `${t(session, "time")}: ${session.selectedSlot.time}\n\n` +
          `${t(session, "paymentLink")}: ${paymentUrl}`,
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "payment_done", title: t(session, "paid") },
          },
        ],
      },
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

      // Handle "My Bookings" button
      if (btnId === "my_bookings_btn") {
        session.step = "AWAIT_BOOKING_MENU";
        await sendWhatsApp(from, waMyBookingsMenu(session));
        return res.sendStatus(200);
      }

      // Handle "Help" button
      if (btnId === "help_btn") {
        session.step = "AWAIT_HELP_NAME";
        await sendWhatsApp(from, {
          type: "text",
          text: {
            body: "Please enter your full name to create a support ticket:",
          },
        });
        return res.sendStatus(200);
      }
    }

    // ===========================
    // 3A. HANDLE MY BOOKINGS SUBMENU BUTTONS
    // ===========================
    if (
      session.step === "AWAIT_BOOKING_MENU" &&
      msg.type === "interactive" &&
      msg.interactive.button_reply
    ) {
      const btnId = msg.interactive.button_reply.id;

      // Handle "Book New Appointment" button
      if (btnId === "book_new_btn") {
        const serviceUrl = `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`;
        const { status, data } = await fetchZoho(serviceUrl, {}, 3, session);

        if (status === 200 && data?.response?.returnvalue?.data?.length) {
          const services = data.response.returnvalue.data;
          session.services = services;
          session.step = "AWAIT_SERVICE";
          await sendWhatsApp(from, waServiceList(session, services));
          return res.sendStatus(200);
        } else {
          await sendWhatsApp(from, waError(session, "noServices"));
          return res.sendStatus(200);
        }
      }

      // Handle "Reschedule" button
      if (btnId === "reschedule_btn") {
        session.step = "AWAIT_RESCHEDULE_PHONE";
        log(
          "RESCHEDULE pressed - sessionId:",
          session.id,
          "from:",
          from,
          "lang:",
          session.language
        );
        await sendWhatsApp(from, waTextPrompt(session, "enterPhone"));
        return res.sendStatus(200);
      }

      // Handle "Cancel" button
      if (btnId === "cancel_btn") {
        session.step = "AWAIT_CANCEL_PHONE";
        log(
          "CANCEL pressed - sessionId:",
          session.id,
          "from:",
          from,
          "lang:",
          session.language
        );
        await sendWhatsApp(from, waTextPrompt(session, "enterPhone"));
        return res.sendStatus(200);
      }
    }

    // ===========================
    // 4. HELP: HOME BUTTON
    // ===========================
    if (
      session.step === "AWAIT_HELP" &&
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

      // ✅ Handle COLLECTIVE/GROUP bookings with month selection
      if (stype === "COLLECTIVE" || stype === "GROUP") {
        if (
          Array.isArray(service.assigned_groups) &&
          service.assigned_groups.length > 0
        ) {
          if (service.assigned_groups.length === 1) {
            session.selectedGroup = service.assigned_groups[0].id;
          } else {
            session.selectedGroup = service.assigned_groups[0].id;
          }
        }

        // Show month selection for collective bookings
        const now = new Date();
        const months = [];
        for (let i = 0; i < 3; ++i) {
          const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
          months.push({
            id: `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(
              2,
              "0"
            )}`,
            label: d.toLocaleString("en-US", {
              month: "long",
              year: "numeric",
              timeZone: "Asia/Kolkata",
            }),
            year: d.getFullYear(),
            month: d.getMonth() + 1,
          });
        }
        session.months = months;
        session.step = "AWAIT_MONTH";
        await sendWhatsApp(from, waMonthList(session, months));
        return res.sendStatus(200);
      }

      // Handle regular APPOINTMENT with staff selection
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

      // ✅ For CLASS or other types, auto-select staff and show months
      if (
        Array.isArray(service.assigned_staffs) &&
        service.assigned_staffs.length > 0
      ) {
        session.selectedStaff = service.assigned_staffs[0];
      }

      const now = new Date();
      const months = [];
      for (let i = 0; i < 3; ++i) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push({
          id: `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(
            2,
            "0"
          )}`,
          label: d.toLocaleString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "Asia/Kolkata",
          }),
          year: d.getFullYear(),
          month: d.getMonth() + 1,
        });
      }
      session.months = months;
      session.step = "AWAIT_MONTH";
      await sendWhatsApp(from, waMonthList(session, months));
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

      // ✅ Show month selection instead of immediate slot search
      const now = new Date();
      const months = [];
      for (let i = 0; i < 3; ++i) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push({
          id: `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(
            2,
            "0"
          )}`,
          label: d.toLocaleString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "Asia/Kolkata",
          }),
          year: d.getFullYear(),
          month: d.getMonth() + 1,
        });
      }
      session.months = months;
      session.step = "AWAIT_MONTH";
      await sendWhatsApp(from, waMonthList(session, months));
      return res.sendStatus(200);
    }

    // ===========================
    // 8. MONTH SELECTION
    // ===========================
    if (
      session.step === "AWAIT_MONTH" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const monthId = msg.interactive.list_reply.id;
      const monthObj = (session.months || []).find((m) => m.id === monthId);

      if (!monthObj) {
        await sendWhatsApp(from, waError(session, "invalidService"));
        session.step = "AWAIT_STAFF";
        return res.sendStatus(200);
      }

      session.selectedMonth = monthObj;

      // ✅ Fetch available dates for the selected month
      await sendWhatsApp(from, waSearchingMessage(session));

      const { year, month } = monthObj;
      const lastDay = new Date(year, month, 0).getDate();
      const availableDates = [];
      const today = new Date();
      const startDay =
        year === today.getFullYear() && month === today.getMonth() + 1
          ? today.getDate()
          : 1;

      const serviceId = session.selectedService.id;
      const serviceType = (
        session.selectedService.service_type || ""
      ).toUpperCase();
      const staffId = session.selectedStaff;
      const groupId = session.selectedGroup;

      for (let day = startDay; day <= lastDay; ++day) {
        const dateObj = new Date(year, month - 1, day);
        const dateStr = formatDateForZoho(dateObj);

        let slotUrl = `${ZOHO_BASE}/availableslots?service_id=${serviceId}&selected_date=${dateStr}`;

        // Add staff_id or group_id based on service type
        if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
          if (groupId) {
            slotUrl += `&group_id=${groupId}`;
          }
        } else {
          if (staffId) {
            slotUrl += `&staff_id=${staffId}`;
          }
        }

        const { data } = await fetchZoho(slotUrl, {}, 3, session);
        const slots = data?.response?.returnvalue?.data;

        if (Array.isArray(slots) && slots.length > 0) {
          availableDates.push({
            id: `date_${dateStr}`,
            label: formatDate(dateObj),
            rawDate: dateStr,
            slots: slots.length,
          });
        }
      }

      if (!availableDates.length) {
        await sendWhatsApp(from, waError(session, "noSlotsAvailable"));
        session.step = "AWAIT_MONTH";
        return res.sendStatus(200);
      }

      session.availableDates = availableDates;
      session.datePage = 0;
      session.step = "AWAIT_DATE";

      // ✅ Show first 9 dates with "Show more" option
      const pageSize = 9;
      const pageDates = availableDates.slice(0, pageSize);
      const dateListMsg = waDateList(session, pageDates, monthObj.label);

      if (availableDates.length > pageSize) {
        dateListMsg.interactive.action.sections[0].rows.push({
          id: "show_more_dates",
          title: t(session, "showMore"),
        });
      }

      await sendWhatsApp(from, dateListMsg);
      return res.sendStatus(200);
    }

    // ===========================
    // 9. DATE SELECTION
    // ===========================
    if (
      session.step === "AWAIT_DATE" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const dateId = msg.interactive.list_reply.id;

      // Handle "Show More" dates
      if (dateId === "show_more_dates") {
        const pageSize = 9;
        session.datePage = (session.datePage || 0) + 1;
        const start = session.datePage * pageSize;
        const pageDates = session.availableDates.slice(start, start + pageSize);

        const dateListMsg = waDateList(
          session,
          pageDates,
          session.selectedMonth.label
        );

        if (session.availableDates.length > start + pageSize) {
          dateListMsg.interactive.action.sections[0].rows.push({
            id: "show_more_dates",
            title: t(session, "showMore"),
          });
        }

        await sendWhatsApp(from, dateListMsg);
        return res.sendStatus(200);
      }

      const dateObj = (session.availableDates || []).find(
        (d) => d.id === dateId
      );

      if (!dateObj) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        session.step = "AWAIT_MONTH";
        return res.sendStatus(200);
      }

      session.selectedDate = dateObj;

      // ✅ Fetch slots for the selected date
      await sendWhatsApp(from, waSearchingMessage(session));

      const serviceId = session.selectedService.id;
      const serviceType = (
        session.selectedService.service_type || ""
      ).toUpperCase();

      let slotUrl = `${ZOHO_BASE}/availableslots?service_id=${serviceId}&selected_date=${dateObj.rawDate}`;

      if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
        if (session.selectedGroup) {
          slotUrl += `&group_id=${session.selectedGroup}`;
        }
      } else {
        if (session.selectedStaff) {
          slotUrl += `&staff_id=${session.selectedStaff}`;
        }
      }

      log("Fetching slots from URL:", slotUrl); // ✅ Add debug log

      try {
        const { data } = await fetchZoho(slotUrl, {}, 3, session);

        log("Slot API response:", JSON.stringify(data)); // ✅ Add debug log

        const slots = Array.isArray(data?.response?.returnvalue?.data)
          ? data.response.returnvalue.data
          : [];

        log("Parsed slots array:", slots); // ✅ Add debug log

        if (!slots.length) {
          await sendWhatsApp(from, waError(session, "noSlotsAvailable"));
          session.step = "AWAIT_DATE";
          return res.sendStatus(200);
        }

        // ✅ Map slots - Zoho returns already formatted times like "09:00 AM"
        session.slots = slots.map((timeStr, idx) => {
          const slotObj = {
            id: `slot_${dateObj.rawDate}_${timeStr.replace(
              /[:\s]/g,
              "-"
            )}_${idx}`,
            label: timeStr,
            time: timeStr,
            rawTime: timeStr,
          };
          log("Created slot object:", slotObj); // ✅ Add debug log
          return slotObj;
        });

        log("Total slots created:", session.slots.length); // ✅ Add debug log

        session.slotPage = 0;
        session.step = "AWAIT_SLOT";

        // ✅ Show first 9 slots with "Show more" option
        const slotPageSize = 9;
        const pageSlots = session.slots.slice(0, slotPageSize);

        log("Page slots to display:", pageSlots); // ✅ Add debug log

        const slotListMsg = waSlotList(session, pageSlots, dateObj.label);

        if (session.slots.length > slotPageSize) {
          slotListMsg.interactive.action.sections[0].rows.push({
            id: "show_more_slots",
            title: t(session, "showMore"),
          });
        }

        log("Sending slot list message:", JSON.stringify(slotListMsg)); // ✅ Add debug log

        await sendWhatsApp(from, slotListMsg);
        return res.sendStatus(200);
      } catch (error) {
        log("Error fetching/processing slots:", error); // ✅ Add error log
        await sendWhatsApp(from, waError(session, "noSlotsAvailable"));
        session.step = "AWAIT_DATE";
        return res.sendStatus(200);
      }
    }

    // ===========================
    // 10. SLOT SELECTION
    // ===========================
    if (
      session.step === "AWAIT_SLOT" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const slotId = msg.interactive.list_reply.id;

      // Handle "Show More" slots
      if (slotId === "show_more_slots") {
        const slotPageSize = 9;
        session.slotPage = (session.slotPage || 0) + 1;
        const start = session.slotPage * slotPageSize;
        const pageSlots = session.slots.slice(start, start + slotPageSize);

        const slotListMsg = waSlotList(
          session,
          pageSlots,
          session.selectedDate.label
        );

        if (session.slots.length > start + slotPageSize) {
          slotListMsg.interactive.action.sections[0].rows.push({
            id: "show_more_slots",
            title: t(session, "showMore"),
          });
        }

        await sendWhatsApp(from, slotListMsg);
        return res.sendStatus(200);
      }

      // User selected a specific slot
      const slotObj = (session.slots || []).find((s) => s.id === slotId);

      if (!slotObj) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        session.step = "AWAIT_DATE";
        return res.sendStatus(200);
      }

      session.selectedSlot = slotObj;

      // Proceed to collect customer details
      await sendWhatsApp(from, waTextPrompt(session, "enterName"));
      session.step = "AWAIT_NAME";
      session.nameAttempts = 0;
      return res.sendStatus(200);
    }

    // ===========================
    // 11. NAME INPUT
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
    // 12. EMAIL INPUT
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
    // 13. PHONE INPUT & BOOKING
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
    // 14. PAYMENT CONFIRMATION CHECK
    // ===========================
    if (session.step === "AWAIT_PAYMENT") {
      // Handle "Paid" button click
      if (
        msg.type === "interactive" &&
        msg.interactive.button_reply?.id === "payment_done"
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

      // Handle text input (backward compatibility)
      if (msg.type === "text") {
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
    }

    // ===========================
    // HELP FLOW: collect name, email, message -> create Zoho Desk ticket
    // ===========================
    if (session.step === "AWAIT_HELP_NAME" && msg.type === "text") {
      session.helpName = msg.text.body.trim();
      session.step = "AWAIT_HELP_EMAIL";
      await sendWhatsApp(from, {
        type: "text",
        text: { body: "Please enter your email address:" },
      });
      return res.sendStatus(200);
    }

    if (session.step === "AWAIT_HELP_EMAIL" && msg.type === "text") {
      const email = msg.text.body.trim();
      if (!validateEmail(email)) {
        session.emailAttempts = (session.emailAttempts || 0) + 1;
        if (session.emailAttempts >= 3) {
          await sendWhatsApp(from, waError(session, "bookingCancelled"));
          clearSession(from);
          return res.sendStatus(200);
        }
        await sendWhatsApp(from, {
          type: "text",
          text: { body: "Invalid email. Please enter a valid email address:" },
        });
        return res.sendStatus(200);
      }
      session.helpEmail = email;
      session.step = "AWAIT_HELP_MESSAGE";
      await sendWhatsApp(from, {
        type: "text",
        text: {
          body: "Please type your message (you can send multiple lines). When done, send the message and we'll create a support ticket.",
        },
      });
      return res.sendStatus(200);
    }

    if (session.step === "AWAIT_HELP_MESSAGE" && msg.type === "text") {
      session.helpMessage = msg.text.body.trim();

      // Create Zoho Desk ticket
      const ticketResult = await createZohoDeskTicket(session);

      if (ticketResult?.id) {
        await sendWhatsApp(from, {
          type: "text",
          text: {
            body: `✅ Support request submitted. Ticket ID: ${ticketResult.id}\nOur team will contact you at ${session.helpEmail}.`,
          },
        });
      } else {
        await sendWhatsApp(from, {
          type: "text",
          text: {
            body: "❌ Failed to create support ticket. Please try again later or contact support.",
          },
        });
      }

      clearSession(from);
      return res.sendStatus(200);
    }

    // Add these handlers AFTER the "HELP FLOW" section and BEFORE the "FALLBACK" section

    // ===========================
    // RESCHEDULE FLOW: Phone Input
    // ===========================
    if (session.step === "AWAIT_RESCHEDULE_PHONE" && msg.type === "text") {
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

      // Show searching message
      await sendWhatsApp(from, waSearchingAppointments(session));

      // ✅ Changed to use phone instead of email
      const appointments = await fetchZohoAppointmentsByPhone(session, phone);
      if (!appointments.length) {
        await sendWhatsApp(from, waError(session, "noAppointmentsFound"));
        session.step = "AWAIT_MAIN";
        return res.sendStatus(200);
      }

      session.appointments = appointments;
      session.appointmentPage = 0;
      session.step = "AWAIT_APPOINTMENT_LIST_RESCHEDULE";
      await sendWhatsApp(
        from,
        waAppointmentList(session, appointments, 0, "reschedule")
      );
      return res.sendStatus(200);
    }

    // ===========================
    // CANCEL FLOW: Phone Input
    // ===========================
    if (session.step === "AWAIT_CANCEL_PHONE" && msg.type === "text") {
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

      // Show searching message
      await sendWhatsApp(from, waSearchingAppointments(session));

      // ✅ Changed to use phone instead of email
      const appointments = await fetchZohoAppointmentsByPhone(session, phone);
      if (!appointments.length) {
        await sendWhatsApp(from, waError(session, "noAppointmentsFound"));
        session.step = "AWAIT_MAIN";
        return res.sendStatus(200);
      }

      session.appointments = appointments;
      session.appointmentPage = 0;
      session.step = "AWAIT_APPOINTMENT_LIST_CANCEL";
      await sendWhatsApp(
        from,
        waAppointmentList(session, appointments, 0, "cancel")
      );
      return res.sendStatus(200);
    }

    // ===========================
    // APPOINTMENT SELECTION (for reschedule/cancel)
    // ===========================
    if (
      (session.step === "AWAIT_APPOINTMENT_LIST_RESCHEDULE" ||
        session.step === "AWAIT_APPOINTMENT_LIST_CANCEL") &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const replyId = msg.interactive.list_reply.id;

      // Handle "Show More" pagination
      if (replyId.startsWith("show_more_appts_")) {
        const parts = replyId.split("_");
        const purpose = parts[3];
        const page = parseInt(parts[4]);
        session.appointmentPage = page;
        await sendWhatsApp(
          from,
          waAppointmentList(session, session.appointments, page, purpose)
        );
        return res.sendStatus(200);
      }

      // Handle appointment selection
      const parts = replyId.split("_appt_");
      if (parts.length !== 2) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        return res.sendStatus(200);
      }

      const purpose = parts[0];
      const ids = parts[1].split("_");

      if (ids.length < 3) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        return res.sendStatus(200);
      }

      const booking_id = ids[0];
      const service_id = ids[1];
      const staff_id = ids[2];

      log("Appointment selection:", {
        purpose,
        booking_id,
        service_id,
        staff_id,
      });

      if (purpose === "cancel") {
        const success = await cancelZohoAppointment(session, booking_id);
        if (success) {
          session.step = "AWAIT_MAIN";
          await sendWhatsApp(from, waSuccessMessage(session, "cancelSuccess"));
        } else {
          await sendWhatsApp(from, waError(session, "cancelFailed"));
        }
        return res.sendStatus(200);
      }

      if (purpose === "reschedule") {
        // Fetch service details to determine service type
        const serviceUrl = `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`;
        const { data } = await fetchZoho(serviceUrl, {}, 3, session);
        const services = data?.response?.returnvalue?.data || [];
        const service = services.find((s) => s.id === service_id);

        if (!service) {
          await sendWhatsApp(from, waError(session, "invalidService"));
          return res.sendStatus(200);
        }

        const serviceType = (service.service_type || "").toUpperCase();

        // Store reschedule data
        session.rescheduleData = { booking_id, service_id, staff_id };
        session.selectedService = service;

        // Set appropriate staff/group based on service type
        if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
          // For collective bookings, use group_id
          session.selectedGroup = service.assigned_groups?.[0]?.id || staff_id;
          session.selectedStaff = null;
        } else {
          // For other types, use staff_id
          session.selectedStaff = staff_id;
          session.selectedGroup = null;
        }

        session.step = "AWAIT_RESCHEDULE_SLOT";

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
        await sendWhatsApp(from, waSlotListWithShowMore(session, slots, true));
        return res.sendStatus(200);
      }
    }

    // ===========================
    // RESCHEDULE SLOT SELECTION
    // ===========================
    if (
      session.step === "AWAIT_RESCHEDULE_SLOT" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const slotId = msg.interactive.list_reply.id;

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

      // Parse selected slot
      const parts = slotId.split("_");
      if (parts.length < 4) {
        await sendWhatsApp(from, waError(session, "invalidSlot"));
        return res.sendStatus(200);
      }

      const dateStr = parts[2]; // "16-Oct-2025"
      const timeStr = parts.slice(3).join(" ").replace(/-/g, ":"); // "10:15 AM"

      // Convert to format: "2025-10-28 14:00:00"
      const [day, month, year] = dateStr.split("-");
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

      // Parse time
      const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2];
      const ampm = timeMatch[3]?.toUpperCase();

      if (ampm) {
        if (ampm === "PM" && hour < 12) hour += 12;
        if (ampm === "AM" && hour === 12) hour = 0;
      }

      const startTime = `${year}-${String(monthIndex + 1).padStart(
        2,
        "0"
      )}-${day} ${String(hour).padStart(2, "0")}:${minute}:00`;

      const success = await rescheduleZohoAppointment(
        session,
        session.rescheduleData.booking_id,
        session.rescheduleData.staff_id,
        startTime
      );

      if (success) {
        await sendWhatsApp(
          from,
          waSuccessMessage(session, "rescheduleSuccess")
        );
      } else {
        await sendWhatsApp(from, waError(session, "rescheduleFailed"));
      }

      clearSession(from);
      return res.sendStatus(200);
    }

    // ===========================
    // FALLBACK
    // ===========================
    session.step = "AWAIT_MAIN";
    await sendWhatsApp(from, waMainMenu(session));
    return res.sendStatus(200);
  } catch (error) {
    log("Webhook error:", error);
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

  // Determine service type and append appropriate ID
  const serviceType = (
    session.selectedService.service_type || ""
  ).toUpperCase();

  // For COLLECTIVE/GROUP bookings, use group_id instead of staff_id
  if (serviceType === "COLLECTIVE" || serviceType === "GROUP") {
    // For collective bookings, group_id is mandatory
    if (session.selectedGroup) {
      formData.append("group_id", session.selectedGroup);
    } else if (session.selectedService.assigned_groups?.length > 0) {
      // Use first assigned group if no group selected
      formData.append(
        "group_id",
        session.selectedService.assigned_groups[0].id
      );
    }
  } else if (serviceType === "RESOURCE") {
    if (session.selectedStaff) {
      formData.append("resource_id", session.selectedStaff);
    } else if (session.selectedService.assigned_staffs?.length > 0) {
      // Use first assigned resource as default
      formData.append(
        "resource_id",
        session.selectedService.assigned_staffs[0]
      );
    }
  } else {
    // Regular APPOINTMENT or CLASS
    if (session.selectedStaff) {
      formData.append("staff_id", session.selectedStaff);
    } else if (session.selectedService.assigned_staffs?.length > 0) {
      // Use first assigned staff as default
      formData.append("staff_id", session.selectedService.assigned_staffs[0]);
    }
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

  // FIXED: Convert 12-hour to 24-hour format properly
  if (ampm === "PM" && hour !== 12) {
    hour += 12;
  } else if (ampm === "AM" && hour === 12) {
    hour = 0;
  }
  // If no AM/PM specified, assume it's already in 24-hour format

  hour = hour.toString().padStart(2, "0");
  const fromTimeStr = `${dateLabel} ${hour}:${minute}:00`;

  let duration = 30;
  if (session.selectedService.duration) {
    const match = session.selectedService.duration.match(/(\d+)/);
    if (match) duration = parseInt(match[1], 10);
  }

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
  formData.append("to_time", toTimeStr); // Always send to_time

  formData.append("timezone", "Asia/Kolkata");

  let notes = "Booked via WhatsApp";
  if (session.stripePaymentId) {
    notes += ` | Payment ID: ${session.stripePaymentId}`;
  }
  formData.append("notes", notes);

  const paidAmount =
    session.stripePaymentAmount ??
    session.paidAmount ??
    (session.stripePaymentId ? session.selectedService?.price ?? 0 : 0);

  formData.append(
    "payment_info",
    JSON.stringify({ cost_paid: Number(paidAmount || 0).toFixed(2) })
  );

  formData.append(
    "customer_details",
    JSON.stringify({
      name: session.customerName,
      email: session.customerEmail,
      phone_number: session.customerPhone,
    })
  );

  // Updated logging
  const idType =
    serviceType === "COLLECTIVE" || serviceType === "GROUP"
      ? "group_id"
      : serviceType === "RESOURCE"
      ? "resource_id"
      : "staff_id";

  // Get the actual ID value being used
  const idValue =
    session.selectedStaff ||
    session.selectedGroup ||
    session.selectedService.assigned_staffs?.[0] ||
    session.selectedService.assigned_groups?.[0]?.id;

  log("Zoho Booking Params", {
    service_id: session.selectedService.id,
    service_type: serviceType,
    id_type: idType,
    id_value: idValue,
    from_time: fromTimeStr,
    to_time: toTimeStr, // Always send to_time
    duration: `${duration} mins`,
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

// Create a Zoho Desk ticket using session.helpName, session.helpEmail, session.helpMessage
async function createZohoDeskTicket(session) {
  try {
    const orgId = process.env.ZOHO_DESK_ORGID; // optional
    const deptId = process.env.ZOHO_DESK_DEPT_ID; // optional

    // Use the same session-based Zoho token as bookings
    const zohoToken = await getSessionZohoToken(session);

    const body = {
      subject: `WhatsApp Support: ${
        session.selectedService?.name || "General"
      }`,
      status: "Open",
      contact: {
        firstName: session.helpName.split(" ")[0] || session.helpName,
        lastName:
          session.helpName.split(" ").slice(1).join(" ") || session.helpName,
        email: session.helpEmail,
      },
      description: session.helpMessage,
    };

    if (deptId) body.departmentId = deptId;

    const resp = await fetch("https://desk.zoho.in/api/v1/tickets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${zohoToken}`,
        ...(orgId ? { orgId } : {}),
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { parseError: true, raw: text };
    }
    log("Zoho Desk create ticket", resp.status, JSON.stringify(data));
    if (resp.status >= 200 && resp.status < 300) {
      return data;
    }
    return null;
  } catch (err) {
    log("Zoho Desk ticket error", err);
    return null;
  }
}

// Add these functions after the waSearchingAppointments function and before the webhook handlers

// ✅ New function to fetch appointments by phone number instead of email
async function fetchZohoAppointmentsByPhone(session, phone) {
  try {
    const zohoToken = await getSessionZohoToken(session);
    const uniqueAppointments = new Set();
    const startDate = new Date();
    const oneWeekFromNow = new Date(startDate);
    oneWeekFromNow.setDate(oneWeekFromNow.getDate() + 7);

    // Format date helper
    const formatDateForZohoFetch = (date) => {
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
      return `${String(date.getDate()).padStart(2, "0")}-${
        monthNames[date.getMonth()]
      }-${date.getFullYear()} ${String(date.getHours()).padStart(
        2,
        "0"
      )}:${String(date.getMinutes()).padStart(2, "0")}:${String(
        date.getSeconds()
      ).padStart(2, "0")}`;
    };

    let currentDate = new Date(startDate);
    let foundAppointments = [];

    // Normalize phone number - remove any non-digits
    const normalizedPhone = phone.replace(/\D/g, "");
    log("Searching appointments with phone:", normalizedPhone);

    while (currentDate <= oneWeekFromNow && foundAppointments.length < 3) {
      const formattedDate = formatDateForZohoFetch(currentDate);
      log("Fetching appointments from date:", formattedDate);

      const resp = await fetch(
        "https://www.zohoapis.in/bookings/v1/json/fetchappointment",
        {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${zohoToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `data=${JSON.stringify({
            customer_phone_number: normalizedPhone,
            from_time: formattedDate,
          })}`,
        }
      );

      const data = await resp.json();
      log(
        "Zoho fetch appointments by phone",
        resp.status,
        JSON.stringify(data)
      );

      if (
        data?.response?.returnvalue?.response &&
        Array.isArray(data.response.returnvalue.response)
      ) {
        const appointments = data.response.returnvalue.response;

        // Filter active appointments
        const activeAppointments = appointments.filter((appt) => {
          const appointmentDate = new Date(
            appt.customer_booking_start_time || appt.start_time
          );
          const now = new Date();
          return (
            appointmentDate > now &&
            !["cancel", "completed"].includes(appt.status) &&
            !uniqueAppointments.has(appt.booking_id)
          );
        });

        // Add unique appointments
        for (const appt of activeAppointments) {
          if (foundAppointments.length >= 3) break;
          if (!uniqueAppointments.has(appt.booking_id)) {
            uniqueAppointments.add(appt.booking_id);
            foundAppointments.push(appt);
          }
        }
      }

      // Move to next day if haven't found 3 appointments yet
      if (foundAppointments.length < 3) {
        currentDate.setDate(currentDate.getDate() + 1);
        // Small delay to prevent rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    log("Found appointments by phone:", foundAppointments.length);
    return foundAppointments;
  } catch (err) {
    log("Zoho fetch appointments by phone error:", err);
    return [];
  }
}

function waAppointmentList(session, appointments, page, purpose) {
  const pageSize = 10;
  const start = page * pageSize;
  const end = start + pageSize;
  const pageAppointments = appointments.slice(start, end);

  const rows = pageAppointments.map((appt) => {
    const startTime = appt.customer_booking_start_time || appt.start_time;
    const dateObj = new Date(startTime);
    const dateStr = formatDate(dateObj);
    const timeStr = dateObj.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });

    return {
      id: `${purpose}_appt_${appt.booking_id}_${appt.service_id}_${appt.staff_id}`,
      title: `${appt.service_name || "Appointment"}`.slice(0, 24),
      description: `${dateStr} ${timeStr}`,
    };
  });

  // Add "Show More" button if there are more appointments
  if (appointments.length > end) {
    rows.push({
      id: `show_more_appts_${purpose}_${page + 1}`,
      title: t(session, "showMore"),
    });
  }

  const bodyText =
    purpose === "reschedule"
      ? t(session, "selectAppointmentToReschedule")
      : t(session, "selectAppointmentToCancel");

  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: t(session, "chooseAppointment"),
        sections: [
          {
            title: t(session, "appointments"),
            rows,
          },
        ],
      },
    },
  };
}

function waSuccessMessage(session, messageKey) {
  return {
    type: "text",
    text: {
      body: `✅ ${t(session, messageKey)}`,
    },
  };
}

async function cancelZohoAppointment(session, bookingId) {
  try {
    const zohoToken = await getSessionZohoToken(session);

    const resp = await fetch(
      `${ZOHO_BASE}/appointment?booking_id=${bookingId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
        },
      }
    );

    const data = await resp.json();
    log("Zoho cancel appointment", resp.status, JSON.stringify(data));

    return resp.status === 200 && data?.response?.status === "success";
  } catch (err) {
    log("Zoho cancel appointment error:", err);
    return false;
  }
}

async function rescheduleZohoAppointment(
  session,
  bookingId,
  staffId,
  startTime
) {
  try {
    const zohoToken = await getSessionZohoToken(session);

    // Calculate end time based on service duration
    let duration = 30; // default
    if (session.selectedService?.duration) {
      const match = session.selectedService.duration.match(/(\d+)/);
      if (match) duration = parseInt(match[1], 10);
    }

    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + duration * 60000);

    const formatZohoDateTime = (date) => {
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
      const hour = String(date.getHours()).padStart(2, "0");
      const minute = String(date.getMinutes()).padStart(2, "0");
      return `${day}-${month}-${year} ${hour}:${minute}:00`;
    };

    const endTime = formatZohoDateTime(endDate);

    const formData = new FormData();
    formData.append("booking_id", bookingId);
    formData.append("start_time", startTime);
    formData.append("end_time", endTime);
    formData.append("staff_id", staffId);

    log("Zoho reschedule params:", {
      booking_id: bookingId,
      start_time: startTime,
      end_time: endTime,
      staff_id: staffId,
    });

    const resp = await fetch(`${ZOHO_BASE}/reschedulebooking`, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${zohoToken}`,
      },
      body: formData,
    });

    const data = await resp.json();
    log("Zoho reschedule appointment", resp.status, JSON.stringify(data));

    return resp.status === 200 && data?.response?.status === "success";
  } catch (err) {
    log("Zoho reschedule appointment error:", err);
    return false;
  }
}
