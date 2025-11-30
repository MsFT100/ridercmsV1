import express from "express";
import { initiateSTK } from "./mpesa.js";
import { db } from "./firebase.js";

export const router = express.Router();

router.post("/pay", async (req, res) => {
  try {
    const { msisdn, amount, slot } = req.body;
    const resp = await initiateSTK(msisdn, amount, slot);

    await db.collection("payments").add({
      msisdn, amount, slot,
      checkoutRequestID: resp.CheckoutRequestID || resp.CheckoutRequestID,
      timestamp: Date.now()
    });

    res.status(200).json({ success: true, mpesa: resp });

  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

router.post("/callback", async (req, res) => {
  const data = req.body;
  await db.collection("payments").add({
    callback: data,
    timestamp: Date.now()
  });
  res.status(200).json({ ok: true });
});
