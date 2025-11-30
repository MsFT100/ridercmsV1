import axios from "axios";
import { ENV } from "../env.js";

export async function initiateSTK(msisdn, amount, account) {
  const token = await getToken();

  const url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0,14);
  const password = Buffer.from(
    ENV.MPESA_SHORTCODE + ENV.MPESA_PASSKEY + timestamp
  ).toString("base64");

  const payload = {
    BusinessShortCode: ENV.MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: msisdn,
    PartyB: ENV.MPESA_SHORTCODE,
    PhoneNumber: msisdn,
    CallBackURL: ENV.CALLBACK_URL,
    AccountReference: account,
    TransactionDesc: "Battery Collection Payment"
  };

  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return data;
}

async function getToken() {
  const cred = Buffer.from(`${ENV.MPESA_CONSUMER_KEY}:${ENV.MPESA_CONSUMER_SECRET}`).toString("base64");

  const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const { data } = await axios.get(url, {
    headers: { Authorization: `Basic ${cred}` }
  });

  return data.access_token;
}
