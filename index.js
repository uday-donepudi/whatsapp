// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import FormData from "form-data"; // CORRECTED: Use default import for CommonJS module

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
      console.log(`📞 Message received from: ${from}, Type: ${message.type}`);

      // --- Handle Interactive Message (User selects a slot) ---
      if (message.type === "interactive") {
        const selection = message.interactive.list_reply;
        console.log("🎯 User selected:", selection);

        let fromTime, toTime;
        // Use a switch statement for the hardcoded slot IDs
        switch (selection.id) {
          case "slot_10am":
            fromTime = "18-Sep-2025 10:00:00";
            toTime = "18-Sep-2025 10:30:00";
            break;
          case "slot_2pm":
            fromTime = "18-Sep-2025 14:00:00";
            toTime = "18-Sep-2025 14:30:00";
            break;
          case "slot_6pm":
            fromTime = "18-Sep-2025 18:00:00";
            toTime = "18-Sep-2025 18:30:00";
            break;
          default:
            console.log("⚠️ Unknown selection id:", selection.id);
            return res.sendStatus(400); // Bad request for unknown ID
        }

        // --- Zoho Booking using FormData (The Corrected Method) ---
        const formData = new FormData();
        const customerDetails = {
          name: "WhatsApp User",
          email: "user@example.com", // This should be a valid email
          phone_number: from,
        };

        formData.append("service_id", SERVICE_ID);
        formData.append("from_time", fromTime);
        formData.append("to_time", toTime);
        formData.append("timezone", "Asia/Kolkata");
        formData.append("notes", "Booked via WhatsApp bot");
        formData.append("customer_details", JSON.stringify(customerDetails));

        console.log("📤 Sending form-data to Zoho...");

        const zohoResp = await fetch(
          "https://www.zohoapis.in/bookings/v1/json/appointment",
          {
            method: "POST",
            headers: {
              Authorization: `Zoho-oauthtoken ${ZOHO_TOKEN}`,
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

        // --- Send Confirmation to User ---
        let confirmationMessage = "";
        if (zohoData?.response?.status === "success") {
          const meetingLink =
            zohoData?.data?.[0]?.appointment_url ||
            "Check your email for details";
          confirmationMessage = `✅ Your meeting is booked!\n📅 Slot: ${selection.title}\n🔗 Join here: ${meetingLink}`;
        } else {
          const errorMsg =
            zohoData?.response?.errormessage ||
            "This slot might no longer be available.";
          confirmationMessage = `❌ Sorry, booking failed. ${errorMsg}`;
        }

        await fetch(
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
              text: { body: confirmationMessage },
            }),
          }
        );
      }

      // --- Handle Text Message (User types "book") ---
      if (message.type === "text") {
        const text = message.text.body.toLowerCase();

        if (text === "book") {
          console.log("📋 Sending hardcoded interactive menu to user...");
          await fetch(
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
        } else {
          // Default reply for any other text
          await fetch(
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
                  body: `👋 You said: "${message.text.body}". Reply with "book" to see available slots.`,
                },
              }),
            }
          );
        }
      }
      return res.sendStatus(200);
    }

    // --- Handle Status Updates ---
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
    console.error("❌ Error in webhook:", err.stack);
    res.sendStatus(500);
  }
});

// ---------------------
// Start server
// ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
