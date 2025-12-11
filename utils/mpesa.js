// utils/mpesa.js
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortCode: process.env.MPESA_SHORTCODE, // Till Number
  passkey: process.env.MPESA_PASSKEY,
  callbackUrl: process.env.MPESA_CALLBACK_URL, // e.g., "/api/mpesa/callback"
  apiUrl: 'https://api.safaricom.co.ke',
};

// --- In-memory cache for the M-Pesa access token ---
let tokenCache = {
  token: null,
  expiresAt: null,
};

// Get access token
const getAccessToken = async () => {
  // If we have a valid token in cache, return it
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  const { data } = await axios.get(`${MPESA_CONFIG.apiUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  // Cache the new token and set its expiry time (e.g., 55 minutes from now)
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in - 300) * 1000; // Refresh 5 mins before expiry

  return data.access_token;
};

// Lipa Na Mpesa STK Push
const initiateSTKPush = async (options) => {
  const { phone, amount, accountRef, transactionDesc } = options;
  const token = await getAccessToken();
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');

  const payload = {
    BusinessShortCode: MPESA_CONFIG.shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: `254${phone.slice(-9)}`, // e.g., 254712345678
    PartyB: MPESA_CONFIG.shortCode,
    PhoneNumber: `254${phone.slice(-9)}`,
    CallBackURL: MPESA_CONFIG.callbackUrl,
    AccountReference: accountRef,
    TransactionDesc: transactionDesc,
  };

  return axios.post(`${MPESA_CONFIG.apiUrl}/mpesa/stkpush/v1/processrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

// B2C (Payout)
const initiateB2CPayout = async (driverPhone, amount, remarks) => {
  const token = await getAccessToken();
  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME,
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL, // Encrypted creds
    CommandID: 'BusinessPayment',
    Amount: amount,
    PartyA: MPESA_CONFIG.shortCode,
    PartyB: `254${driverPhone.slice(-9)}`,
    Remarks: remarks,
    QueueTimeOutURL: `${MPESA_CONFIG.callbackUrl}?type=b2c`,
    ResultURL: MPESA_CONFIG.callbackUrl,
    Occasion: 'DriverPayout',
  };

  return axios.post(`${MPESA_CONFIG.apiUrl}/mpesa/b2c/v1/paymentrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

module.exports = { initiateSTKPush, initiateB2CPayout };
