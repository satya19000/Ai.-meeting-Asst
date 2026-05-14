# ═══════════════════════════════════════════════════
#  backend/Dockerfile.bot  —  Puppeteer Bot Worker
# ═══════════════════════════════════════════════════
FROM node:20-slim

# Install Chromium, FFmpeg, Xvfb, PulseAudio
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    xvfb \
    pulseaudio \
    dbus \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libxshmfence1 libasound2 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY bot/ ./bot/
COPY src/config/ ./src/config/
COPY src/services/encryptionService.js ./src/services/
RUN mkdir -p recordings

# Start Xvfb + PulseAudio + bot worker
COPY docker/bot-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9222
ENTRYPOINT ["/entrypoint.sh"]
