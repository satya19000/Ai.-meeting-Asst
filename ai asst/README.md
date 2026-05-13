# 🧠 MeetIQ AI — Meeting Intelligence Platform

> AI-powered government & enterprise meeting secretary — joins meetings automatically, transcribes speech in English + Telugu, generates summaries, captures slides, and produces official MoM documents.

---

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENTS                                 │
│   Browser PWA  ·  Mobile App  ·  WhatsApp  ·  Telegram         │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTPS / WebSocket
┌────────────────────────────▼────────────────────────────────────┐
│                      NGINX (Reverse Proxy)                      │
│              SSL Termination · Rate Limiting                    │
└──────┬──────────────────────────────────────────┬──────────────┘
       │                                          │
┌──────▼───────────┐                   ┌──────────▼──────────────┐
│  Node.js API     │  internal HTTP    │  Python FastAPI          │
│  Express +       │◄──────────────────│  AI Microservice         │
│  Socket.IO       │                   │  Whisper · GPT-4o        │
│  Port 4000       │                   │  Deepgram · AssemblyAI   │
└──────┬───────────┘                   │  OCR · Translation       │
       │                               └──────────────────────────┘
       │ Bull Queues
┌──────▼───────────┐    ┌─────────────────────────────────────────┐
│  Redis           │    │  Bot Worker (Puppeteer)                  │
│  Sessions        │    │  Chromium + Xvfb + FFmpeg + PulseAudio  │
│  Pub/Sub         │    │  Joins: Zoom · Meet · Teams · WebEx     │
│  Caching         │    │  Records audio · Captures slides        │
└──────┬───────────┘    └────────────────┬────────────────────────┘
       │                                 │ Audio files
┌──────▼───────────┐    ┌───────────────▼─────────────────────────┐
│  PostgreSQL 16   │    │  AWS S3 / MinIO                          │
│  Full-text search│    │  Recordings · Exports · Slides          │
│  8 core tables   │    └─────────────────────────────────────────┘
└──────────────────┘
```

---

## 📁 Project Structure

```
meetiq-ai/
├── backend/
│   ├── src/
│   │   ├── app.js                # Express entry point
│   │   ├── config/
│   │   │   ├── db.js             # PostgreSQL pool
│   │   │   └── index.js          # Redis · S3 · Logger
│   │   ├── middleware/
│   │   │   └── auth.js           # JWT · RBAC · validation
│   │   ├── routes/
│   │   │   ├── auth.js           # Login · Register · 2FA
│   │   │   ├── meetings.js       # Meeting CRUD + lifecycle
│   │   │   └── combined.js       # Bot · Actions · Summary · MoM · Search · Analytics
│   │   ├── queues/
│   │   │   └── index.js          # Bull: AI pipeline · bot · notifications · exports
│   │   └── services/
│   │       └── index.js          # Export · Notification · Encryption · Cron · Socket
│   ├── bot/
│   │   └── worker.js             # Puppeteer bot worker
│   ├── Dockerfile                # API container
│   ├── Dockerfile.bot            # Bot container
│   └── package.json
├── ai-service/
│   ├── main.py                   # FastAPI AI microservice
│   ├── requirements.txt
│   └── Dockerfile
├── database/
│   ├── schema.sql                # Full PostgreSQL schema (12 tables)
│   └── seed.sql                  # Development seed data
├── docker/
│   └── bot-entrypoint.sh         # Xvfb + PulseAudio startup
├── nginx/
│   └── nginx.conf                # Reverse proxy + SSL
├── docker-compose.yml            # Full orchestration
├── .env.example                  # All environment variables
└── README.md
```

---

## 🚀 Quick Start

### Prerequisites
- Docker Desktop ≥ 24 with Docker Compose v2
- 8 GB RAM minimum (bot worker needs ~2 GB alone)
- API keys: OpenAI (required), optionally Deepgram/AssemblyAI

### 1. Clone & Configure

```bash
git clone https://github.com/your-org/meetiq-ai.git
cd meetiq-ai

# Copy and fill environment variables
cp .env.example .env
nano .env   # Fill in OPENAI_API_KEY, DB passwords, JWT secrets etc.
```

### 2. Generate Secrets

```bash
# JWT secrets (run twice for two different values)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start All Services

```bash
# Production
docker compose up -d

# Development (includes MinIO for local S3)
docker compose --profile dev up -d

# View logs
docker compose logs -f api ai bot
```

### 4. Initialize Database

```bash
# Schema + seed data run automatically on first start via postgres init scripts
# To run manually:
docker compose exec postgres psql -U meetiq_user -d meetiq -f /docker-entrypoint-initdb.d/01_schema.sql
docker compose exec postgres psql -U meetiq_user -d meetiq -f /docker-entrypoint-initdb.d/02_seed.sql
```

### 5. Verify

```bash
# API health
curl http://localhost:4000/health

# AI service health
curl http://localhost:8000/health

# API docs
open http://localhost:8000/docs
```

---

## 📡 API Reference

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Create account |
| POST | `/api/v1/auth/login` | Get access + refresh tokens |
| POST | `/api/v1/auth/refresh` | Rotate tokens |
| POST | `/api/v1/auth/logout` | Revoke tokens |
| POST | `/api/v1/auth/2fa/setup` | Enable 2FA (TOTP) |
| POST | `/api/v1/auth/2fa/verify` | Confirm 2FA code |

### Meetings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/meetings` | List meetings (with filters) |
| POST | `/api/v1/meetings` | Create new meeting |
| GET | `/api/v1/meetings/:id` | Get full meeting details |
| PUT | `/api/v1/meetings/:id` | Update meeting |
| DELETE | `/api/v1/meetings/:id` | Cancel meeting |
| POST | `/api/v1/meetings/:id/start` | Mark as started |
| POST | `/api/v1/meetings/:id/end` | End + trigger AI pipeline |

### Bot
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/bot/launch` | Launch Puppeteer bot |
| GET | `/api/v1/bot/session/:id` | Get session status |
| POST | `/api/v1/bot/session/:id/terminate` | Stop bot |

### AI Intelligence
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/summaries/meeting/:id` | Get all summaries |
| POST | `/api/v1/summaries/generate` | Generate summary on demand |
| GET | `/api/v1/mom/:meeting_id` | Get Minutes of Meeting |
| POST | `/api/v1/mom/generate` | Generate MoM |
| POST | `/api/v1/mom/:id/approve` | Approve MoM |

### Search & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/search?q=dengue` | Full-text search across all content |
| GET | `/api/v1/analytics/overview` | Dashboard metrics |
| GET | `/api/v1/actions?overdue=true` | Action items (with filters) |

### AI Microservice (Internal)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/transcribe` | Audio → text (multi-engine) |
| POST | `/summarize` | Transcript → EN+Telugu summary |
| POST | `/extract-actions` | Transcript → action items |
| POST | `/generate-mom` | Transcript → full MoM JSON |
| POST | `/translate` | EN ↔ Telugu translation |
| POST | `/ocr` | Image → text + AI notes |

---

## 🔄 Meeting Lifecycle

```
User pastes link → Bot launches → Joins meeting (Puppeteer)
       ↓
   Recording starts (FFmpeg + Xvfb)
       ↓
   Slide screenshots every 10s (change detection)
       ↓
User clicks "End" → Bot terminates → Recording uploads to S3
       ↓
   AI Pipeline (Bull queue):
   1. Transcribe audio (Whisper/Deepgram/AssemblyAI)
   2. Speaker diarization (GPT-4o)
   3. Generate summaries (brief + detailed + Telugu)
   4. Extract action items with assignments + deadlines
   5. Generate full MoM document (EN + Telugu)
   6. OCR slide screenshots
   7. Export PDF → upload to S3
   8. Notify all participants (Email + WhatsApp + Telegram)
       ↓
   Meeting status → "done" | WebSocket pushes to frontend
```

---

## 🌍 Telugu Language Support

MeetIQ uses GPT-4o's multilingual capabilities:

- **Mixed language detection**: Identifies Telugu segments in real-time via Unicode range check (U+0C00–U+0C7F)
- **Translation**: All summaries auto-translated to Telugu via GPT-4o
- **OCR**: Tesseract with `tesseract-ocr-tel` for slide text extraction
- **MoM**: Bilingual output with Telugu decisions and summary sections

---

## 🔒 Security

| Feature | Implementation |
|---------|---------------|
| Authentication | JWT (15min access) + rotating refresh tokens (7 days) |
| Password storage | bcrypt (12 rounds) |
| 2FA | TOTP via speakeasy (RFC 6238) |
| Meeting credentials | AES-256-GCM encrypted at rest |
| Token revocation | Redis blacklist for access tokens |
| Recording files | AES-256 SSE on S3 |
| Role-based access | super_admin > district_officer > department_staff > viewer |
| Rate limiting | Nginx + Express rate-limit (auth: 20/15min, API: 500/15min) |
| Audit log | Full action trail in `audit_log` table |
| Cross-org isolation | Org ID enforced on every DB query |

---

## 📊 Database Schema

12 core tables:

| Table | Purpose |
|-------|---------|
| `organisations` | Multi-tenant org management |
| `users` | Accounts with roles, preferences |
| `meetings` | All meeting records (all platforms) |
| `meeting_participants` | Per-meeting attendance |
| `bot_sessions` | Bot join/record sessions |
| `transcripts` | Full transcript documents |
| `transcript_segments` | Speaker-diarized utterances with word timestamps |
| `summaries` | AI summaries (brief/detailed/bilingual/telugu) |
| `action_items` | Extracted action items with assignments |
| `slide_captures` | Screenshots with OCR and AI notes |
| `minutes_of_meeting` | Structured MoM with export URLs |
| `notifications` | Multi-channel notification log |

---

## 🛠 Development

```bash
# Backend only (hot reload)
cd backend && npm run dev

# AI service only
cd ai-service && uvicorn main:app --reload --port 8000

# Run tests
cd backend && npm test

# Lint
cd backend && npm run lint
```

---

## 🚢 Production Deployment

### Using Docker Compose (VPS)

```bash
# Build all images
docker compose build --parallel

# Start with restart policy
docker compose up -d

# Scale API instances
docker compose up -d --scale api=3

# SSL setup (Certbot)
certbot certonly --standalone -d meetiq.yourdomain.com
cp /etc/letsencrypt/live/meetiq.yourdomain.com/fullchain.pem nginx/ssl/
cp /etc/letsencrypt/live/meetiq.yourdomain.com/privkey.pem nginx/ssl/
docker compose restart nginx
```

### Kubernetes (Helm) — Coming Soon

---

## 📦 Environment Checklist

Before going live, confirm:

- [ ] `OPENAI_API_KEY` set with sufficient credits
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are random 64-byte hex values
- [ ] `ENCRYPTION_KEY` is a random 32-byte hex value
- [ ] `POSTGRES_PASSWORD` and `REDIS_PASSWORD` are strong
- [ ] `AWS_S3_BUCKET` created with proper IAM permissions
- [ ] SendGrid / Twilio / Telegram configured for notifications
- [ ] SSL certificates placed in `nginx/ssl/`
- [ ] `FRONTEND_URL` set to your production domain

---

## 📞 Support

- Issues: GitHub Issues
- Docs: `/api/v1/docs` (Swagger UI via AI service)
- Health: `GET /health` (API), `GET /health` (AI service)

---

*MeetIQ AI — Built for Government & Enterprise Meeting Intelligence*
*Telangana Health Department · District Administration · Smart Governance*
