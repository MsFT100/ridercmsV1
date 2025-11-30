RiderCMS collectionpay-service (sandbox preconfigured)

Files included:
- app.js
- package.json
- src/env.js (fill placeholders with your keys)
- src/fireba se.js
- src/mpesa.js
- src/routes.js

Instructions:
1. Edit src/env.js: replace placeholders (PASSKEY, CALLBACK_URL, FIREBASE CLIENT details).
2. Install deps: npm install
3. Run locally: node app.js
4. Deploy to Cloud Run: gcloud run deploy collectionpay-service --source . --region europe-west1 --project ridercms-ced94
