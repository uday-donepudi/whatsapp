// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Load environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ZOHO_TOKEN = process.env.ZOHO_TOKEN;
const SERVICE_ID = process.env.SERVICE_ID;
const WHATSAPP_NUMBER_ID = process.env.WHATSAPP_NUMBER_ID; // Your WhatsApp Business number ID

console.log("🔹 Environment Variables Loaded:");
console.log({
  VERIFY_TOKEN,
  WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  ZOHO_TOKEN: !!ZOHO_TOKEN,
  SERVICE_ID,
  WHATSAPP_NUMBER_ID,
});

// ---------------------
// Step 1: Webhook verification (Meta / WhatsApp)
// ---------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔹 Webhook verification attempt:", { mode, token, challenge });

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Verification successful");
    return res.status(200).send(challenge);
  }

  console.log("❌ Verification failed");
  res.sendStatus(403);
});

// ---------------------
// Step 2: Receive messages
// ---------------------
app.post("/webhook", async (req, res) => {
  console.log("🔥 Webhook triggered");
  console.log("📥 Raw request body:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) {
      console.log("⚠️ No message found in payload");
      return res.sendStatus(200);
    }

    const from = message.from;
    console.log("📞 Message received from:", from);
    console.log("📝 Message type:", message.type);

    // ---------------------
    // Interactive messages (list buttons)
    // ---------------------
    if (message.type === "interactive") {
      const selection = message.interactive.list_reply;
      console.log("🎯 User selected:", selection);

      // Map selection to Zoho times
      let fromTime, toTime;
      switch (selection.id) {
        case "slot_10am":
          fromTime = "16-Sep-2025 10:00:00";
          toTime = "16-Sep-2025 10:30:00";
          break;
        case "slot_2pm":
          fromTime = "16-Sep-2025 14:00:00";
          toTime = "16-Sep-2025 14:30:00";
          break;
        case "slot_6pm":
          fromTime = "16-Sep-2025 18:00:00";
          toTime = "16-Sep-2025 18:30:00";
          break;
        default:
          console.log("⚠️ Unknown selection id:", selection.id);
          return res.sendStatus(400);
      }

      // Prepare payload for Zoho
      const payload = {
        service_id: SERVICE_ID,
        from_time: fromTime,
        to_time: toTime,
        timezone: "Asia/Kolkata",
        customer_details: {
          name: "John",
          email: "destinations694@gmail.com",
          phone_number: from,
        },
        notes: "Booked via WhatsApp bot",
        payment_info: { cost_paid: "0.00" },
      };

      const zohoResp = await fetch(
        "https://www.zohoapis.in/bookings/v1/json/appointment",
        {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const zohoText = await zohoResp.text();
      console.log("Zoho Status:", zohoResp.status);
      console.log("Zoho Body:", zohoText);

      let zohoData;
      try {
        zohoData = JSON.parse(zohoText);
      } catch (err) {
        console.error("❌ Failed to parse Zoho response:", err);
        zohoData = {};
      }

      const meetingLink =
        zohoData?.data?.[0]?.appointment_url || "Check your email for details";

      // Send confirmation to WhatsApp
      const whatsappResp = await fetch(
        `https://graph.facebook.com/v17.0/${WHATSAPP_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: {
              body: `✅ Your meeting is booked!\n📅 Slot: ${selection.title}\n🔗 Join here: ${meetingLink}`,
            },
          }),
        }
      );
      const whatsappData = await whatsappResp.json();
      console.log("📬 WhatsApp response:", whatsappData);
    }

    // ---------------------
    // Text messages
    // ---------------------
    if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      console.log("💬 Text received:", text);

      if (text === "book") {
        console.log("📋 Sending interactive menu to user...");
        const response = await fetch(
          `https://graph.facebook.com/v17.0/${WHATSAPP_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: from,
              type: "interactive",
              interactive: {
                type: "list",
                body: { text: "📅 Please choose a meeting slot:" },
                action: {
                  button: "Select Slot",
                  sections: [
                    {
                      title: "Available Slots",
                      rows: [
                        { id: "slot_10am", title: "10:00 AM - 10:30 AM" },
                        { id: "slot_2pm", title: "2:00 PM - 2:30 PM" },
                        { id: "slot_6pm", title: "6:00 PM - 6:30 PM" },
                      ],
                    },
                  ],
                },
              },
            }),
          }
        );
        const data = await response.json();
        console.log("📬 WhatsApp menu response:", data);
      } else {
        console.log("💡 Sending default reply to user...");
        const response = await fetch(
          `https://graph.facebook.com/v17.0/${WHATSAPP_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: from,
              type: "text",
              text: {
                body: `👋 You said: "${text}". Reply with "book" to see slots.`,
              },
            }),
          }
        );
        const data = await response.json();
        console.log("📬 Default reply response:", data);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error in webhook:", err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
