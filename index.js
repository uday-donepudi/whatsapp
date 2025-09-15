import FormData from "form-data";
// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ZOHO_TOKEN = process.env.ZOHO_TOKEN;
const SERVICE_ID = process.env.SERVICE_ID;

console.log("🔹 Environment Variables Loaded:");
console.log({
  VERIFY_TOKEN,
  WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  ZOHO_TOKEN: !!ZOHO_TOKEN,
  SERVICE_ID,
});

// ✅ Step 1: Webhook verification (for Meta)
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

// ✅ Step 2: Receive messages
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

    // Interactive messages (list buttons)
    if (message.type === "interactive") {
      const selection = message.interactive.list_reply;
      console.log("🎯 User selected:", selection);


      const form = new FormData();
      form.append("service_id", SERVICE_ID);
      form.append("from_time", fromTime);
      form.append("to_time", toTime);
      form.append("timezone", "Asia/Kolkata");
      form.append(
        "customer_details",
        JSON.stringify({
          name: "John",
          email: "destinations694@gmail.com",
          phone_number: from,
        })
      );
      form.append("notes", "Booked via WhatsApp bot");
      form.append("payment_info", JSON.stringify({ cost_paid: "0.00" }));

      const zohoResp = await fetch(
        "https://www.zohoapis.in/bookings/v1/json/appointment",
        {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}` },
          body: form,
        }
      );

      let zohoData;
      try {
        if (zohoResp.ok) {
          zohoData = await zohoResp.json();
        } else {
          const text = await zohoResp.text();
          console.error("❌ Zoho API error:", zohoResp.status, text);
          zohoData = {};
        }
      } catch (err) {
        console.error("❌ Failed to parse Zoho response:", err);
        zohoData = {};
      }

      console.log("✅ Zoho Response:", zohoData);

      const meetingLink =
        zohoData?.data?.[0]?.appointment_url || "Check your email for details";

      console.log("📤 Sending confirmation back to WhatsApp...");
      const whatsappResp = await fetch(
        "https://graph.facebook.com/v17.0/735873456285955/messages",
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

    // Text messages
    if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      console.log("💬 Text received:", text);

      if (text === "book") {
        console.log("📋 Sending interactive menu to user...");
        const response = await fetch(
          "https://graph.facebook.com/v17.0/735873456285955/messages",
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
          "https://graph.facebook.com/v17.0/735873456285955/messages",
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

app.listen(3000, () => console.log("🚀 Webhook running on port 3000"));
