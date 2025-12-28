// utils/mpesa.js
const axios = require('axios');
const logger = require('./logger'); // Import logger for warnings
const crypto = require('crypto');
require('dotenv').config();

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortCode: process.env.MPESA_SHORTCODE, // Till Number
  passkey: process.env.MPESA_PASSKEY,
  baseUrl: process.env.MPESA_BASE_URL, // e.g., "https://your-ngrok-url.io"
  apiUrl: 'https://api.safaricom.co.ke',
};

/**
 * Returns an array of whitelisted M-Pesa IP addresses.
 * In a real-world scenario, these should be managed carefully.
 * @returns {string[]}
 */
const getMpesaIpWhitelist = () => {
  // These are example IPs. You should get the official list from Safaricom documentation.
  // It's better to store this in environment variables for flexibility.
  // e.g., MPESA_WHITELISTED_IPS="196.201.214.200,196.201.214.206"
  return process.env.MPESA_WHITELISTED_IPS?.split(',') || [];
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

  // Sanity check for amount
  if (amount < 1) {
    logger.warn(`Attempted to initiate STK push with invalid amount: ${amount}`);
    throw new Error('M-Pesa amount must be at least 1.');
  }

  const token = await getAccessToken();
  const timestamp = getTimestamp(); // Use the corrected timestamp function
  const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');

  const payload = {
    BusinessShortCode: MPESA_CONFIG.shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount), // M-Pesa API expects an integer
    PartyA: `254${phone.slice(-9)}`, // e.g., 254712345678
    PartyB: MPESA_CONFIG.shortCode,
    PhoneNumber: `254${phone.slice(-9)}`,
    CallBackURL: `${MPESA_CONFIG.baseUrl}/api/mpesa/callback`,
    AccountReference: accountRef,
    TransactionDesc: transactionDesc,
  };

  return axios.post(`${MPESA_CONFIG.apiUrl}/mpesa/stkpush/v1/processrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

/**
 * Generates a timestamp in the required M-Pesa format (YYYYMMDDHHMMSS).
 * @returns {string} The formatted timestamp.
 */
const getTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

/**
 * Queries the status of a previously initiated STK push transaction.
 * @param {string} checkoutRequestId The CheckoutRequestID from the initial STK push.
 * @returns {Promise<object>} A promise that resolves with the M-Pesa query response.
 */
const querySTKStatus = async (checkoutRequestId) => {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');

  const payload = {
    BusinessShortCode: MPESA_CONFIG.shortCode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  return axios.post(`${MPESA_CONFIG.apiUrl}/mpesa/stkpushquery/v1/query`, payload, {
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
    QueueTimeOutURL: `${MPESA_CONFIG.baseUrl}/api/mpesa/callback?type=b2c_timeout`,
    ResultURL: `${MPESA_CONFIG.baseUrl}/api/mpesa/callback?type=b2c_result`,
    Occasion: 'DriverPayout',
  };

  return axios.post(`${MPESA_CONFIG.apiUrl}/mpesa/b2c/v1/paymentrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

module.exports = { initiateSTKPush, initiateB2CPayout, querySTKStatus, getMpesaIpWhitelist };
