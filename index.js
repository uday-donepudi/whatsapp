// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import FormData from "form-data";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
app.use(bodyParser.json());

// ---------------------
// Environment variables
// ---------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ZOHO_TOKEN = process.env.ZOHO_TOKEN;
const SERVICE_ID = process.env.SERVICE_ID;
const WHATSAPP_NUMBER_ID = process.env.WHATSAPP_NUMBER_ID;

console.log("🔹 Environment Variables Loaded:", {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  ZOHO_TOKEN: !!ZOHO_TOKEN,
  SERVICE_ID,
  WHATSAPP_NUMBER_ID,
});

// ---------------------
// Webhook verification
// ---------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔹 Webhook verification attempt:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Verification successful");
    return res.status(200).send(challenge);
  }

  console.log("❌ Verification failed");
  res.sendStatus(403);
});

// ---------------------
// Handle incoming webhook events
// ---------------------
app.post("/webhook", async (req, res) => {
  console.log("🔥 Webhook triggered");
  console.log("📥 Raw request body:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // ---------------------
    // Incoming message
    // ---------------------
    if (value?.messages?.length) {
      const message = value.messages[0];
      const from = message.from;
      console.log("📞 Message received from:", from);
      console.log("📝 Message type:", message.type);

      // Interactive messages (list buttons)
      if (message.type === "interactive") {
        const selection = message.interactive.list_reply;
        console.log("🎯 User selected:", selection);

        const formData = new FormData();

        // Map selection to Zoho times
        let fromTime, toTime;
        switch (selection.id) {
          case "slot_10am":
            fromTime = "17-Sep-2025 10:00:00";
            toTime = "17-Sep-2025 10:30:00";
            break;
          case "slot_2pm":
            fromTime = "17-Sep-2025 14:00:00";
            toTime = "17-Sep-2025 14:30:00";
            break;
          case "slot_6pm":
            fromTime = "17-Sep-2025 18:00:00";
            toTime = "17-Sep-2025 18:30:00";
            break;
          default:
            console.log("⚠️ Unknown selection id:", selection.id);
            return res.sendStatus(400);
        }

        // Create form data (matching your working Postman request)
        formData.append("service_id", SERVICE_ID);
        formData.append("from_time", fromTime);
        formData.append("to_time", toTime);
        formData.append("timezone", "Asia/Kolkata");

        // Customer details as JSON string (exactly like in Postman)
        formData.append(
          "customer_details",
          JSON.stringify({
            name: "John Doe",
            email: "destinations694@gmail.com",
            phone_number: from,
          })
        );

        formData.append("notes", "Booked via WhatsApp bot");

        // Payment info as JSON string
        formData.append(
          "payment_info",
          JSON.stringify({
            cost_paid: "0.00",
          })
        );

        console.log("📤 Sending form data to Zoho");

        const zohoResp = await fetch(
          "https://www.zohoapis.in/bookings/v1/json/appointment",
          {
            method: "POST",
            headers: {
              ...formData.getHeaders(),
              Authorization: ZOHO_TOKEN,
            },
            body: formData,
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

        // Check for success and get meeting link
        let meetingLink = "Check your email for details";
        let confirmationMessage = "";

        if (zohoData?.response?.status === "success") {
          meetingLink =
            zohoData?.data?.[0]?.appointment_url ||
            zohoData?.response?.appointment_url ||
            meetingLink;
          confirmationMessage = `✅ Your meeting is booked!\n📅 Slot: ${selection.title}\n🔗 Join here: ${meetingLink}`;
        } else {
          const errorMsg = zohoData?.response?.errormessage || "Unknown error";
          console.error("❌ Zoho booking failed:", errorMsg);
          confirmationMessage = `❌ Sorry, booking failed. Please try again.\nError: ${errorMsg}`;
        }

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
                body: confirmationMessage,
              },
            }),
          }
        );
        const whatsappData = await whatsappResp.json();
        console.log("📬 WhatsApp response:", whatsappData);
      }

      return res.sendStatus(200);
    }

    // ---------------------
    // Status updates (sent/delivered/read)
    // ---------------------
    if (value?.statuses?.length) {
      const status = value.statuses[0];
      console.log(
        "ℹ️ Status update received:",
        status.status,
        "for",
        status.recipient_id
      );
      return res.sendStatus(200);
    }

    console.log("⚠️ No message or status found in payload");
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error in webhook:", err);
    res.sendStatus(500);
  }
});

// ---------------------
// Start server
// ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
