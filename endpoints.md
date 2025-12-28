# API Endpoint Documentation

This document provides a detailed overview of the API endpoints for the Battery Swap Service.

**Base URL:** `/api`

---

## 1. Authentication (`/auth`)

### `POST /auth/register`

Registers a new user in the system.

- **Auth:** None
- **Request Body:**

    ```json
    {
      "email": "user@example.com",
      "password": "strongpassword123",
      "name": "John Doe",
      "phoneNumber": "+15551234567",
      "recaptchaToken": "recaptcha_token_from_client"
    }
    ```

- **Success Response (201):**

    ```json
    {
      "message": "User registered successfully.",
      "userId": "firebase_uid",
      "role": "user"
    }
    ```

- **Error Responses:**
  - `400`: Bad Request (e.g., missing fields, invalid reCAPTCHA).
  - `409`: Conflict (e.g., email already exists).
  - `500`: Internal Server Error.

### `POST /auth/sessionLogin`

Logs a user in by creating a session cookie from a Firebase ID token.

- **Auth:** None
- **Request Body:**

    ```json
    {
      "idToken": "firebase_id_token_from_client",
      "recaptchaToken": "recaptcha_token_from_client"
    }
    ```

- **Success Response (200):**

    ```json
    {
      "status": "success",
      "message": "User logged in successfully.",
      "user": {
        "firebaseUid": "...",
        "email": "...",
        "displayName": "...",
        "phoneNumber": "...",
        "role": "user",
        "status": "active",
        "phoneVerified": true,
        "balance": "0.00",
        "activeBatterySession": {
            "batteryUid": "bat_123",
            "chargeLevel": 85,
            "boothUid": "booth_001",
            "slotIdentifier": "slot_001"
        }
      }
    }
    ```

- **Error Responses:**
  - `401`: Unauthorized (invalid token).
  - `403`: Forbidden (account inactive).
  - `404`: Not Found (user profile missing in DB).

### `POST /auth/verify-phone`

Marks a user's phone number as verified after a successful OTP flow on the client.

- **Auth:** None
- **Request Body:**

    ```json
    {
      "idToken": "firebase_id_token_from_phone_auth"
    }
    ```

- **Success Response (200):**

    ```json
    {
      "status": "success",
      "message": "Phone number verified successfully."
    }
    ```

- **Error Responses:**
  - `401`: Unauthorized (invalid token).

---

## 2. Booths & Swapping (`/booths`)

### `POST /booths/initiate-deposit`

Initiates a battery deposit process by finding and reserving an available slot.

- **Auth:** User Session Cookie
- **Request Body:**

    ```json
    {
      "boothUid": "booth_001"
    }
    ```

- **Success Response (200):**

    ```json
    {
      "message": "Slot allocated. Please deposit your battery.",
      "boothUid": "booth_001",
      "slotIdentifier": "slot_003"
    }
    ```

### `POST /booths/confirm-deposit`

**Called by booth hardware.** Confirms a battery has been deposited.

- **Auth:** API Key
- **Request Body:**

    ```json
    {
      "boothUid": "booth_001",
      "slotIdentifier": "slot_003",
      "batteryUid": "bat_xyz789",
      "chargeLevel": 65
    }
    ```

- **Success Response (200):**

    ```json
    {
      "success": true,
      "message": "Deposit confirmed."
    }
    ```

### `GET /booths/my-battery-status`

Allows a logged-in user to check the status of their deposited battery.

- **Auth:** User Session Cookie
- **Success Response (200):**

    ```json
    {
      "batteryUid": "bat_xyz789",
      "chargeLevel": 98,
      "boothUid": "booth_001",
      "slotIdentifier": "slot_003"
    }
    ```

- **Error Response (404):**

    ```json
    {
      "message": "No battery currently deposited."
    }
    ```

### `POST /booths/report-problem`

Allows a user to report an issue with a battery or a booth slot.

- **Auth:** User Session Cookie
- **Request Body:**

    ```json
    {
      "boothUid": "booth_001",
      "slotIdentifier": "slot_005",
      "description": "The door for this slot won't close properly."
    }
    ```

    _OR_

    ```json
    {
      "batteryUid": "bat_abc123",
      "description": "This battery seems to be draining very quickly."
    }
    ```

- **Success Response (201):**

    ```json
    {
      "message": "Your problem report has been submitted successfully. Thank you!"
    }
    ```

### `POST /booths/initiate-withdrawal`

Initiates the process for a user to collect their charged battery, calculating the cost and triggering an M-Pesa STK push.

- **Auth:** User Session Cookie
- **Request Body:** None
- **Success Response (200):**

    ```json
    {
      "message": "Please complete the payment on your phone to proceed.",
      "checkoutRequestId": "ws_CO_...",
      "amount": 250
    }
    ```

- **Error Responses:**
  - `404`: Not Found (User has no battery deposited).
  - `500`: Internal Server Error (e.g., M-Pesa API issue).

### `GET /booths/withdrawal-status/:checkoutRequestId`

Allows the client application to poll for the payment status of a withdrawal session.

- **Auth:** User Session Cookie
- **URL Parameters:**
  - `checkoutRequestId` (string, required)
- **Success Response (200):**

    ```json
    {
      "paymentStatus": "paid"
    }
    ```

    _OR_

    ```json
    {
      "paymentStatus": "pending"
    }
    ```

### `POST /booths/open-for-collection`

Called by the client after payment is confirmed to command the hardware to unlock the slot.

- **Auth:** User Session Cookie
- **Request Body:**

    ```json
    {
      "checkoutRequestId": "ws_CO_..."
    }
    ```

- **Success Response (200):**

    ```json
    {
      "message": "Your battery is ready for collection. The slot will now open."
    }
    ```

### `GET /booths/history`

Retrieves the deposit and withdrawal history for the logged-in user.

- **Auth:** User Session Cookie
- **Success Response (200):**

    ```json
    [
      {
        "sessionType": "deposit",
        "status": "completed",
        "startedAt": "...",
        "completedAt": "...",
        "boothUid": "booth_001",
        "slotIdentifier": "slot_003",
        "batteryUid": "bat_xyz789"
      }
    ]
    ```

---

## 3. M-Pesa Webhooks (`/mpesa`)

### `POST /mpesa/callback`

The webhook URL that M-Pesa calls to notify our system about the status of an STK push transaction.

- **Auth:** None (Publicly accessible, but requests originate from M-Pesa)
- **Request Body:** (M-Pesa specific format)

    ```json
    {
      "Body": {
        "stkCallback": {
          "MerchantRequestID": "...",
          "CheckoutRequestID": "...",
          "ResultCode": 0,
          "ResultDesc": "The service request is processed successfully.",
          "CallbackMetadata": { ... }
        }
      }
    }
    ```

- **Success Response (200):** (Sent immediately to M-Pesa)

    ```json
    {
      "ResultCode": 0,
      "ResultDesc": "Accepted"
    }
    ```

---

## 4. Administration (`/admin`)

All admin endpoints require an authenticated session with a user who has the `admin` role.

### `GET /admin/booths/status`

Retrieves a comprehensive status of all booths, their slots, and any batteries within them.

- **Auth:** Admin Session Cookie
- **Success Response (200):** A JSON array of booth objects.

### `GET /admin/users`

Retrieves a paginated list of all users.

- **Auth:** Admin Session Cookie
- **Query Parameters:**
  - `pageSize` (number, optional, default: 100)
  - `pageToken` (string, optional)
- **Success Response (200):**

    ```json
    {
      "users": [ ... ],
      "nextPageToken": "..."
    }
    ```

### `POST /admin/users/set-role`

Sets a custom role for a specified user.

- **Auth:** Admin Session Cookie
- **Request Body:**

    ```json
    {
      "uid": "user_firebase_uid",
      "newRole": "admin"
    }
    ```

### `POST /admin/users/set-status`

Activates, deactivates, or suspends a user account.

- **Auth:** Admin Session Cookie
- **Request Body:**

    ```json
    {
      "uid": "user_firebase_uid",
      "status": "suspended"
    }
    ```

### `GET /admin/problem-reports`

Retrieves a list of problem reports submitted by users.

- **Auth:** Admin Session Cookie
- **Query Parameters:**
  - `status` (string, optional): 'open', 'investigating', 'resolved', 'wont_fix'
  - `limit` (number, optional, default: 50)
  - `offset` (number, optional, default: 0)
- **Success Response (200):** A JSON array of report objects.

### `POST /admin/problem-reports/:reportId/status`

Updates the status of a specific problem report.

- **Auth:** Admin Session Cookie
- **URL Parameters:**
  - `reportId` (number, required)
- **Request Body:**

    ```json
    {
      "status": "investigating"
    }
    ```

- **Success Response (200):**

    ```json
    {
      "message": "Report status updated successfully.",
      "report": { ... }
    }
    ```
