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

// ✅ Step 1: Webhook verification (for Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ✅ Step 2: Receive messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message?.type === "interactive") {
      const from = message.from; // WhatsApp user phone
      const selection = message.interactive.list_reply;

      console.log("User selected:", selection);

      // map slot to Zoho time
      let fromTime, toTime;
      if (selection.id === "slot_10am") {
        fromTime = "15-Sep-2025 10:00:00";
        toTime = "15-Sep-2025 10:30:00";
      } else if (selection.id === "slot_2pm") {
        fromTime = "15-Sep-2025 14:00:00";
        toTime = "15-Sep-2025 14:30:00";
      } else if (selection.id === "slot_6pm") {
        fromTime = "15-Sep-2025 18:00:00";
        toTime = "15-Sep-2025 18:30:00";
      }

      // ✅ Step 3: Book in Zoho
      const formData = new URLSearchParams();
      formData.append("service_id", SERVICE_ID);
      formData.append("from_time", fromTime);
      formData.append("to_time", toTime);
      formData.append("timezone", "Asia/Kolkata");
      formData.append(
        "customer_details",
        JSON.stringify({
          name: "John",
          email: "destinations694@gmail.com",
          phone_number: from, // WhatsApp number
        })
      );
      formData.append("notes", "Booked via WhatsApp bot");
      formData.append("payment_info", JSON.stringify({ cost_paid: "0.00" }));

      const zohoResp = await fetch(
        "https://www.zohoapis.in/bookings/v1/json/appointments",
        {
          method: "POST",
          headers: { Authorization: ZOHO_TOKEN },
          body: formData,
        }
      );
      const zohoData = await zohoResp.json();
      console.log("Zoho Response:", zohoData);

      // extract meeting link if available
      const meetingLink =
        zohoData?.data?.[0]?.appointment_url || "Check your email for details";

      // ✅ Step 4: Reply on WhatsApp
      await fetch("https://graph.facebook.com/v17.0/735873456285955/messages", {
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
      });
    } else if (message.type === "text") {
      console.log("Text message:", message.text.body);
      // Optional: send menu here
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log("🚀 Webhook running on port 3000"));
