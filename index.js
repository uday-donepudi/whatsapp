// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import FormData from "form-data";
import { v4 as uuidv4 } from "uuid";

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

async function fetchZoho(url, opts = {}, retries = 3) {
  try {
    const resp = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}`,
      },
    });
    if (resp.status === 429 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000 * (4 - retries)));
      return fetchZoho(url, opts, retries - 1);
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
      return fetchZoho(url, opts, retries - 1);
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
function waBookButton() {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Hi! Ready to book an appointment?" },
      action: {
        buttons: [{ type: "reply", reply: { id: "book_btn", title: "Book" } }],
      },
    },
  };
}

function waServiceList(services) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Select a service:" },
      action: {
        button: "Choose Service",
        sections: [
          {
            title: "Services",
            rows: services.slice(0, 10).map((s) => ({
              id: s.id,
              title: s.name.length > 24 ? s.name.slice(0, 21) + "..." : s.name, // Truncate to 24 chars
              description: s.duration || s.service_type,
            })),
          },
        ],
      },
    },
  };
}

function waMonthList(months) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Choose a month:" },
      action: {
        button: "Select Month",
        sections: [
          {
            title: "Months",
            rows: months.map((m) => ({
              id: m.id,
              title: m.label,
            })),
          },
        ],
      },
    },
  };
}

function waDateList(dates, monthLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: `Available dates in ${monthLabel}:` },
      action: {
        button: "Select Date",
        sections: [
          {
            title: "Dates",
            rows: dates.map((d) => ({
              id: d.id,
              title: d.label,
              description: `${d.slots} slots`,
            })),
          },
        ],
      },
    },
  };
}

function waSlotList(slots, dateLabel) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: `Available slots on ${dateLabel}:` },
      action: {
        button: "Select Slot",
        sections: [
          {
            title: "Slots",
            rows: slots.map((s) => ({
              id: s.id,
              title: s.label,
            })),
          },
        ],
      },
    },
  };
}

function waTextPrompt(prompt, id) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: prompt },
      action: {
        buttons: [{ type: "reply", reply: { id, title: "Reply" } }],
      },
    },
  };
}

function waConfirmation(details) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `✅ Booking confirmed!\nService: ${details.service}\nDate: ${details.date}\nTime: ${details.time}\nRef: ${details.ref}`,
      },
      action: {
        buttons: [
          {
            type: "url",
            url: details.url,
            title: "View details",
          },
          {
            type: "reply",
            reply: { id: "cancel_booking", title: "Cancel" },
          },
        ],
      },
    },
  };
}

function waError(msg) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `❌ ${msg}` },
      action: {
        buttons: [
          { type: "reply", reply: { id: "try_again", title: "Try again" } },
          {
            type: "reply",
            reply: { id: "contact_support", title: "Contact support" },
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

    // Step 1: Any inbound message → Book button
    if (session.step === "INIT") {
      await sendWhatsApp(from, waBookButton());
      session.step = "AWAIT_BOOK";
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
        `${ZOHO_BASE}/services?workspace_id=${WORKSPACE_ID}`
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
      await sendWhatsApp(from, waServiceList(services));
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
      await sendWhatsApp(from, waMonthList(months));
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
      for (let day = 1; day <= lastDay; ++day) {
        const dateStr = `${String(day).padStart(2, "0")}-${monthObj.label
          .split(" ")[0]
          .substr(0, 3)}-${year}`;
        const slotUrl = `${ZOHO_BASE}/availableslots?service_id=${session.selectedService.id}&selected_date=${dateStr}`;
        const { data } = await fetchZoho(slotUrl);
        const slots = data?.response?.returnvalue?.data || [];
        if (slots.length) {
          availableDates.push({
            id: `date_${dateStr}`,
            label: dateStr,
            slots: slots.length,
          });
        }
      }
      if (!availableDates.length) {
        await sendWhatsApp(
          from,
          waError(`No slots in ${monthObj.label}. Choose another month.`)
        );
        session.step = "AWAIT_MONTH";
        return res.sendStatus(200);
      }
      session.availableDates = availableDates;
      await sendWhatsApp(from, waDateList(availableDates, monthObj.label));
      session.step = "AWAIT_DATE";
      return res.sendStatus(200);
    }

    // Step 5: Date selected
    if (
      session.step === "AWAIT_DATE" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const dateId = msg.interactive.list_reply.id;
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
      const { data } = await fetchZoho(slotUrl);
      const slots = data?.response?.returnvalue?.data || [];
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
      await sendWhatsApp(from, waSlotList(session.slots, dateObj.label));
      session.step = "AWAIT_SLOT";
      return res.sendStatus(200);
    }

    // Step 6: Slot selected
    if (
      session.step === "AWAIT_SLOT" &&
      msg.type === "interactive" &&
      msg.interactive.list_reply
    ) {
      const slotId = msg.interactive.list_reply.id;
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
        waTextPrompt("Please enter your full name.", "name_prompt")
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
          waTextPrompt("Name invalid. Please enter again.", "name_prompt")
        );
        return res.sendStatus(200);
      }
      session.customerName = name;
      await sendWhatsApp(
        from,
        waTextPrompt("Enter your email address.", "email_prompt")
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
          waTextPrompt("Email invalid. Please enter again.", "email_prompt")
        );
        return res.sendStatus(200);
      }
      session.customerEmail = email;
      await sendWhatsApp(
        from,
        waTextPrompt("Enter your phone number.", "phone_prompt")
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
          waTextPrompt("Phone invalid. Please enter again.", "phone_prompt")
        );
        return res.sendStatus(200);
      }
      session.customerPhone = phone;
      // All info collected, create appointment
      const formData = new FormData();
      formData.append("service_id", session.selectedService.id);
      formData.append(
        "from_time",
        `${session.selectedDate.label} ${session.selectedSlot.time}`
      );
      // Calculate to_time based on duration (assume 30 mins if not provided)
      const duration = parseInt(session.selectedService.duration) || 30;
      const [h, m] = session.selectedSlot.time.split(":").map(Number);
      const fromDate = new Date(
        `${session.selectedDate.label} ${h}:${m}:00 GMT+0530`
      );
      const toDate = new Date(fromDate.getTime() + duration * 60000);
      const toTime = toDate.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      });
      formData.append("to_time", `${session.selectedDate.label} ${toTime}`);
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
      const zohoResp = await fetch(`${ZOHO_BASE}/appointment`, {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}`,
        },
        body: formData,
      });
      const zohoText = await zohoResp.text();
      let zohoData;
      try {
        zohoData = JSON.parse(zohoText);
      } catch {
        zohoData = {};
      }
      log("Zoho appointment", zohoResp.status, zohoText);
      if (zohoData?.response?.status === "success") {
        const appt = zohoData.response.returnvalue.data[0];
        await sendWhatsApp(
          from,
          waConfirmation({
            service: session.selectedService.name,
            date: session.selectedDate.label,
            time: session.selectedSlot.label,
            ref: appt.id,
            url: appt.appointment_url,
          })
        );
        clearSession(from);
      } else {
        await sendWhatsApp(from, waError("Booking failed. Please try again."));
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
