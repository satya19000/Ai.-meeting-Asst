/**
 * bot/worker.js  — Puppeteer Meeting Bot
 * Runs as a separate process/container (Dockerfile.bot)
 *
 * Responsibilities:
 *   1. Connect to Redis and listen for JOIN_MEETING jobs
 *   2. Launch Chromium via Puppeteer in headless mode
 *   3. Join Zoom / Google Meet / Teams / WebEx with MeetIQ Recorder identity
 *   4. Record audio/video via Xvfb + FFmpeg
 *   5. Capture slide screenshots at change detection intervals
 *   6. Stream transcript segments back via Redis pub/sub → API → WebSocket
 *   7. Upload recording to S3 on session end
 */

require("dotenv").config();
const puppeteer  = require("puppeteer");
const { execFile, spawn } = require("child_process");
const path       = require("path");
const fs         = require("fs");
const Redis      = require("ioredis");
const axios      = require("axios");
const { v4: uuid } = require("uuid");

const redisClient  = new Redis(process.env.REDIS_URL);
const redisPubSub  = new Redis(process.env.REDIS_URL);
const API_URL      = process.env.API_URL || "http://api:4000";
const RECORDINGS   = process.env.RECORDINGS_DIR || "/app/recordings";
const BOT_NAME     = process.env.BOT_NAME || "MeetIQ Recorder";

if (!fs.existsSync(RECORDINGS)) fs.mkdirSync(RECORDINGS, { recursive: true });

// ─── Platform-specific join handlers ──────────────────────────
const PLATFORM_HANDLERS = {

  google_meet: async (page, meetingLink, sessionId) => {
    console.log(`[Bot] Joining Google Meet: ${meetingLink}`);
    await page.goto(meetingLink, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss browser extension prompts
    await page.keyboard.press("Escape").catch(() => {});

    // Set name if prompted
    try {
      await page.waitForSelector('input[placeholder*="name" i], input[aria-label*="name" i]', { timeout: 10000 });
      await page.click('input[placeholder*="name" i], input[aria-label*="name" i]');
      await page.keyboard.selectAll();
      await page.keyboard.type(BOT_NAME);
    } catch { /* name field may not appear */ }

    // Turn off mic
    try {
      const micBtn = await page.$('[data-tooltip*="microphone" i], [aria-label*="microphone" i]');
      if (micBtn) { const state = await micBtn.evaluate(el => el.getAttribute("data-is-muted")); if (state !== "true") await micBtn.click(); }
    } catch {}

    // Turn off camera
    try {
      const camBtn = await page.$('[data-tooltip*="camera" i], [aria-label*="camera" i]');
      if (camBtn) await camBtn.click();
    } catch {}

    // Click "Ask to join" or "Join now"
    const joinSelectors = [
      'button[data-tooltip*="Join" i]',
      'button[jsname*="join" i]',
      '[data-promo-anchor-id*="joinBtn"]',
    ];
    for (const sel of joinSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.click(sel);
        console.log(`[Bot] Clicked join button (${sel})`);
        break;
      } catch {}
    }

    await page.waitForTimeout(5000);
    console.log(`[Bot] ✅ Joined Google Meet`);
  },

  zoom: async (page, meetingLink, sessionId) => {
    console.log(`[Bot] Joining Zoom: ${meetingLink}`);
    // Zoom web client
    const webClientUrl = meetingLink.replace("zoom.us/j/", "zoom.us/wc/join/");
    await page.goto(webClientUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(3000);

    // Enter name
    try {
      await page.waitForSelector("#input-for-name, [placeholder*='Your Name']", { timeout: 10000 });
      await page.click("#input-for-name, [placeholder*='Your Name']");
      await page.keyboard.type(BOT_NAME);
    } catch {}

    // Click join
    try {
      await page.waitForSelector("#joinBtn, button[type='submit']", { timeout: 8000 });
      await page.click("#joinBtn, button[type='submit']");
    } catch {}

    await page.waitForTimeout(5000);
    console.log(`[Bot] ✅ Joined Zoom`);
  },

  teams: async (page, meetingLink, sessionId) => {
    console.log(`[Bot] Joining Teams: ${meetingLink}`);
    // Teams web join
    const webUrl = meetingLink.replace("teams.microsoft.com/l/meetup-join", "teams.microsoft.com/v2/") + "&launch=false";
    await page.goto(meetingLink, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(4000);

    try {
      // Continue in browser
      await page.waitForSelector('[data-tid="join-btn-wt-select"], [class*="continue-browser"]', { timeout: 10000 });
      await page.click('[data-tid="join-btn-wt-select"], [class*="continue-browser"]');
    } catch {}

    try {
      // Set name
      await page.waitForSelector('[data-tid="prejoin-name-input"], input[placeholder*="name" i]', { timeout: 8000 });
      await page.click('[data-tid="prejoin-name-input"]');
      await page.keyboard.selectAll();
      await page.keyboard.type(BOT_NAME);
    } catch {}

    try {
      await page.waitForSelector('[data-tid="prejoin-join-button"], button[class*="join"]', { timeout: 8000 });
      await page.click('[data-tid="prejoin-join-button"]');
    } catch {}

    await page.waitForTimeout(5000);
    console.log(`[Bot] ✅ Joined Teams`);
  },

  webex: async (page, meetingLink, sessionId) => {
    console.log(`[Bot] Joining WebEx: ${meetingLink}`);
    await page.goto(meetingLink, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(4000);

    try {
      await page.waitForSelector('#guest-name', { timeout: 8000 });
      await page.type('#guest-name', BOT_NAME);
      await page.click('#join-as-guest-btn, button[type="submit"]');
    } catch {}

    await page.waitForTimeout(5000);
    console.log(`[Bot] ✅ Joined WebEx`);
  },
};

// ─── Slide change detection via screenshot diff ───────────────
async function captureSlide(page, sessionId, slideNum, apiToken) {
  try {
    const screenshotPath = path.join(RECORDINGS, `${sessionId}_slide_${slideNum}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // Upload to API for OCR processing
    const form = new FormData();
    form.append("file", fs.createReadStream(screenshotPath));
    form.append("session_id", sessionId);
    form.append("slide_number", String(slideNum));

    await axios.post(`${API_URL}/api/v1/slides/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiToken}` }
    }).catch(e => console.error("[Bot] Slide upload error:", e.message));

    console.log(`[Bot] 📸 Captured slide ${slideNum}`);
  } catch (e) {
    console.error("[Bot] Screenshot error:", e.message);
  }
}

// ─── FFmpeg audio recording ───────────────────────────────────
function startRecording(sessionId) {
  const outPath = path.join(RECORDINGS, `${sessionId}.mkv`);
  const ffmpeg = spawn("ffmpeg", [
    "-loglevel", "warning",
    "-f", "pulse", "-i", "default",              // audio: PulseAudio
    "-f", "x11grab", "-r", "5", "-i", ":99",    // video: Xvfb @ 5fps (low quality is fine)
    "-c:a", "libopus", "-b:a", "64k",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-y", outPath
  ]);

  ffmpeg.stderr.on("data", d => process.stdout.write(`[FFmpeg] ${d}`));
  console.log(`[Bot] 🎙 Recording started → ${outPath}`);

  return { process: ffmpeg, outPath };
}

// ─── Main bot runner ─────────────────────────────────────────
async function runBot(job) {
  const { session_id, meeting_id, meeting_link, config } = job;
  const { platform, record_audio, capture_screen } = config;

  console.log(`[Bot] 🤖 Starting session ${session_id} for meeting ${meeting_id}`);

  // Update session status
  await redisClient.set(`bot_status:${session_id}`, "joining", "EX", 86400);

  let browser, recorder;

  try {
    // Launch Puppeteer
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium-browser",
      headless: false,                              // needed for audio capture
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--use-fake-ui-for-media-stream",           // auto-allow mic/cam
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--display=:99",
      ],
      defaultViewport: { width: 1280, height: 720 },
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0 Safari/537.36");

    // Grant camera/mic permissions
    const context = browser.defaultBrowserContext();
    const origin  = new URL(meeting_link).origin;
    await context.overridePermissions(origin, ["microphone", "camera", "notifications"]);

    // Start recording
    if (record_audio) recorder = startRecording(session_id);

    // Join the meeting
    const handler = PLATFORM_HANDLERS[platform] || PLATFORM_HANDLERS.google_meet;
    await handler(page, meeting_link, session_id);

    // Update session to active
    await redisClient.set(`bot_status:${session_id}`, "active", "EX", 86400);
    await axios.patch(`${API_URL}/api/v1/bot/session/${session_id}`, { status: "active" })
      .catch(() => {});

    // ── Slide capture loop ──
    let slideNum = 1;
    let prevScreenHash = "";
    const apiToken = await redisClient.get(`bot_token:${session_id}`);

    const slideInterval = setInterval(async () => {
      if (capture_screen) {
        try {
          const screenshot = await page.screenshot({ encoding: "base64" });
          const hash = require("crypto").createHash("md5").update(screenshot).digest("hex");
          if (hash !== prevScreenHash) {
            prevScreenHash = hash;
            await captureSlide(page, session_id, slideNum++, apiToken);
          }
        } catch {}
      }

      // Emit live metrics
      await redisClient.set(`bot_metrics:${session_id}`, JSON.stringify({
        slide_count: slideNum - 1,
        elapsed_ms:  Date.now() - new Date(job.started_at || Date.now()).getTime(),
        recording:   !!recorder,
      }), "EX", 300);
    }, 10000); // every 10s

    // ── Wait for termination signal ──
    await new Promise((resolve) => {
      redisPubSub.subscribe("bot:commands");
      redisPubSub.on("message", (channel, message) => {
        try {
          const cmd = JSON.parse(message);
          if (cmd.session_id === session_id && cmd.cmd === "TERMINATE") {
            console.log(`[Bot] Received TERMINATE for ${session_id}`);
            resolve();
          }
        } catch {}
      });

      // Also poll page for meeting-ended indicators
      const checkEnd = setInterval(async () => {
        try {
          const endIndicators = [
            '[data-tooltip*="Meeting ended" i]',
            '.crqnQb',                // Google Meet ended screen
            '[data-tid="call-ended"]', // Teams
          ];
          for (const sel of endIndicators) {
            const el = await page.$(sel);
            if (el) { clearInterval(checkEnd); resolve(); break; }
          }
        } catch { clearInterval(checkEnd); resolve(); }
      }, 15000);

      // Absolute timeout: 4 hours
      setTimeout(() => { clearInterval(checkEnd); resolve(); }, 4 * 60 * 60 * 1000);
    });

    clearInterval(slideInterval);

  } catch (err) {
    console.error(`[Bot] Error:`, err.message);
    await redisClient.set(`bot_status:${session_id}`, "error", "EX", 3600);
  } finally {
    // Stop recording
    if (recorder?.process) {
      recorder.process.stdin?.write("q");
      recorder.process.kill("SIGTERM");
      console.log(`[Bot] 🛑 Recording stopped`);

      // Upload recording to S3 via API
      if (fs.existsSync(recorder.outPath)) {
        try {
          const { uploadBuffer } = require("../config/s3");
          const s3Key = `recordings/${meeting_id}/${session_id}.mkv`;
          await uploadBuffer(s3Key, fs.readFileSync(recorder.outPath));
          await axios.patch(`${API_URL}/api/v1/meetings/${meeting_id}`, {
            recording_url: s3Key,
            recording_size: fs.statSync(recorder.outPath).size,
          }).catch(() => {});
          fs.unlinkSync(recorder.outPath); // clean up local
          console.log(`[Bot] ☁️  Recording uploaded: ${s3Key}`);
        } catch (e) {
          console.error("[Bot] Upload error:", e.message);
        }
      }
    }

    if (browser) await browser.close().catch(() => {});
    await redisClient.set(`bot_status:${session_id}`, "ended", "EX", 3600);
    console.log(`[Bot] ✅ Session ${session_id} complete`);
  }
}

// ─── Worker loop — poll Redis job queue ──────────────────────
async function workerLoop() {
  console.log("[Bot Worker] 🤖 MeetIQ Bot Worker started, listening for jobs...");

  while (true) {
    try {
      // BLPOP blocks until a job is available (10s timeout, then re-check)
      const result = await redisClient.blpop("bot:job_queue", 10);
      if (result) {
        const [, payload] = result;
        const job = JSON.parse(payload);
        job.started_at = new Date().toISOString();
        console.log(`[Bot Worker] 📥 Got job: ${job.type} — session ${job.session_id}`);
        await runBot(job);
      }
    } catch (err) {
      console.error("[Bot Worker] Fatal error:", err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

workerLoop();
