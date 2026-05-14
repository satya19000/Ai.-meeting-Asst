# ════════════════════════════════════════════════════════════════
#  MeetIQ AI — Environment Variables (.env.example)
#  Copy to .env and fill in all values before starting
# ════════════════════════════════════════════════════════════════

# ─── Node / General ──────────────────────────────────────────
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://meetiq.yourdomain.com
LOG_LEVEL=info

# ─── PostgreSQL ───────────────────────────────────────────────
POSTGRES_DB=meetiq
POSTGRES_USER=meetiq_user
POSTGRES_PASSWORD=CHANGE_ME_STRONG_PASSWORD
# Full URL (auto-constructed from above in docker-compose, override here if using external DB)
DATABASE_URL=postgresql://meetiq_user:CHANGE_ME@localhost:5432/meetiq

# ─── Redis ───────────────────────────────────────────────────
REDIS_PASSWORD=CHANGE_ME_REDIS_PASSWORD
REDIS_URL=redis://:CHANGE_ME_REDIS_PASSWORD@localhost:6379

# ─── JWT Authentication ───────────────────────────────────────
# Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=GENERATE_64_BYTE_HEX_SECRET
JWT_REFRESH_SECRET=GENERATE_DIFFERENT_64_BYTE_HEX_SECRET

# ─── Encryption (AES-256) ────────────────────────────────────
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=GENERATE_32_BYTE_HEX_KEY

# ─── AWS S3 Storage ───────────────────────────────────────────
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=ap-south-1
AWS_S3_BUCKET=meetiq-recordings-prod

# ─── AI Services ─────────────────────────────────────────────
# Primary: OpenAI (required)
OPENAI_API_KEY=sk-...

# Transcription alternatives (pick at least one)
ASSEMBLYAI_API_KEY=your_assemblyai_key
DEEPGRAM_API_KEY=your_deepgram_key

# Transcription engine: whisper | deepgram | assemblyai | google
TRANSCRIPTION_ENGINE=whisper

# Google Cloud (for Google Speech-to-Text)
# GOOGLE_CREDENTIALS_JSON=base64_encoded_service_account_json

# ─── Email (SendGrid) ─────────────────────────────────────────
SENDGRID_API_KEY=SG.xxxxxxxxxx
FROM_EMAIL=noreply@meetiq.ai
FROM_NAME=MeetIQ AI

# ─── WhatsApp (Twilio) ────────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_WHATSAPP_FROM=+14155238886

# ─── Telegram Bot ────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ─── Web Push Notifications (VAPID) ─────────────────────────
# Generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:admin@meetiq.ai

# ─── Local Dev — MinIO (replaces S3 in dev) ──────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin123
# Set S3 endpoint override for local MinIO:
# S3_ENDPOINT=http://localhost:9000

# ─── AI Microservice ──────────────────────────────────────────
AI_SERVICE_URL=http://localhost:8000

# ─── Bot Worker ───────────────────────────────────────────────
BOT_NAME=MeetIQ Recorder
RECORDINGS_DIR=/app/recordings
