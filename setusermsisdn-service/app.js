const express = require("express");
const bodyParser = require("body-parser");
const app = express();

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} -> ${req.method} ${req.url}`);
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Root health check
app.get("/", (req, res) => res.send("Service is running"));
app.get("/health", (req, res) => res.send("OK"));

// Set user MSISDN (mock)
app.post("/setUserMsisdn", (req, res) => {
  const { uid, msisdn } = req.body || {};
  if (!uid || !msisdn)
    return res.status(400).json({ error: "uid and msisdn required" });
  console.log("setUserMsisdn payload:", { uid, msisdn });
  return res.json({ message: "MSISDN set", uid, msisdn });
});

// Collection payment (mock)
app.post("/collectionPay", (req, res) => {
  const { msisdn, amount, slot } = req.body || {};
  if (!msisdn || !amount)
    return res.status(400).json({ error: "msisdn and amount required" });
  console.log("collectionPay payload:", { msisdn, amount, slot });
  return res.json({ message: "Payment received", msisdn, amount, slot });
});

// Catch-all 404
app.all("*", (req, res) => res.status(404).json({ error: "Not found" }));

// Bind to 0.0.0.0 so Cloud Run, Docker, and Git Bash can access the service
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`setusermsisdn service listening on ${PORT} (rev: ${Date.now()})`)
);
