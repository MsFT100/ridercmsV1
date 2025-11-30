import admin from "firebase-admin";
import { ENV } from "../env.js";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: ENV.FIREBASE_PROJECT_ID,
      clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
      privateKey: ENV.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: `https://${ENV.FIREBASE_PROJECT_ID}.firebaseio.com`,
  });
}

export const db = admin.firestore();
export const rtdb = admin.database();
