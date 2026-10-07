# Ping — WebRTC Video Chat

One-on-one and group video calls with email/phone accounts, 

## Quick start

```bash
cd ping-video-chat
npm install
npm start          # serves http://localhost:3000
```

> Requires Node.js 18+ (uses `crypto.randomUUID` and `node --watch` in dev).

## Try it out

1. Open `http://localhost:3000` in **two browser windows** (or two machines on the
   same network — see HTTPS note below).
2. **Sign up** in each window with a different email or phone number
   (e.g. `alice@example.com` / `+15551234567`).
3. In window A, add window B's account via **Contacts → Add by email or phone**.
4. Click **Video call** on the contact — window B gets an incoming-call popup.
5. Create a **group** from contacts, then hit **Group call**: every online member
   is invited and joins a mesh WebRTC call.

## Architecture

```
ping-video-chat/
├── package.json          # express, socket.io, jsonwebtoken, bcryptjs
├── server/
│   ├── index.js          # REST API (auth/contacts/groups) + Socket.IO signaling
│   └── db.js             # JSON-file DB (swap for Postgres/Mongo in production)
├── public/
│   ├── index.html        # login, contacts, groups, modals, call view
│   ├── app.js            # API client, WebRTC mesh, call lifecycle
│   └── style.css
└── data/db.json          # created automatically at first run
```

### Backend

| Endpoint | Description |
|---|---|
| `POST /api/register` | Create account with email **or** phone + password (bcrypt) |
| `POST /api/login` | Returns JWT (30-day expiry) |
| `GET /api/me` | Current profile |
| `GET/POST/DELETE /api/contacts` | WhatsApp-style contacts, added by email/phone |
| `GET/POST /api/groups` | Groups whose members are the owner's contacts |

**Signaling over Socket.IO (JWT-authenticated):**

- `call:start {callType, targetId}` → server creates a call room and pushes
  `call:incoming` to the target user (or every online group member)
- `call:accept` → joins the room; existing participants are notified via
  `call:peer-joined` and each initiates a WebRTC offer to the newcomer
- `rtc:offer` / `rtc:answer` / `rtc:ice` → relayed peer-to-peer between the
  two sockets of the target user
- `call:leave` / disconnect → `call:peer-left`, rooms auto-destroyed when empty

### WebRTC (frontend, `public/app.js`)

- Mesh topology: every participant holds one `RTCPeerConnection` per other
  participant. Works well for small groups (up to ~6–8 people); for larger
  groups swap in an SFU (e.g. mediasoup, LiveKit, Janus).
- Existing participants always initiate offers to newcomers — this avoids
  offer/answer glare when several people join at once.
- Google STUN servers are preconfigured. **For production**, add a TURN server
  to `RTC_CONFIG` in `app.js` so calls survive symmetric NATs, and set
  `JWT_SECRET` as an environment variable.

### HTTPS / camera access

Browsers only grant `getUserMedia` on `localhost` or HTTPS origins. For LAN or
public deployment, put the app behind HTTPS (e.g. `caddy`, `nginx` + Let's
Encrypt, or a tunnel like `ngrok`).
