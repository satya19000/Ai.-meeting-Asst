{
  "name": "meetiq-api",
  "version": "1.0.0",
  "description": "MeetIQ AI — Node.js REST API + WebSocket Server",
  "main": "src/app.js",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start":   "node src/app.js",
    "dev":     "nodemon src/app.js",
    "test":    "jest --coverage",
    "migrate": "node src/db/migrate.js",
    "seed":    "node src/db/seed.js",
    "lint":    "eslint src/",
    "format":  "prettier --write src/"
  },
  "dependencies": {
    "express":              "^4.19.2",
    "express-rate-limit":   "^7.3.1",
    "express-validator":    "^7.1.0",
    "cors":                 "^2.8.5",
    "helmet":               "^7.1.0",
    "compression":          "^1.7.4",
    "morgan":               "^1.10.0",

    "pg":                   "^8.12.0",
    "pg-pool":              "^3.6.2",
    "ioredis":              "^5.4.1",
    "bull":                 "^4.12.9",

    "jsonwebtoken":         "^9.0.2",
    "bcrypt":               "^5.1.1",
    "speakeasy":            "^2.0.0",
    "qrcode":               "^1.5.3",

    "multer":               "^1.4.5-lts.1",
    "multer-s3":            "^3.0.1",
    "@aws-sdk/client-s3":   "^3.600.0",
    "@aws-sdk/s3-request-presigner": "^3.600.0",

    "socket.io":            "^4.7.5",

    "nodemailer":           "^6.9.14",
    "@sendgrid/mail":       "^8.1.3",
    "twilio":               "^5.2.3",
    "node-telegram-bot-api":"^0.66.0",
    "web-push":             "^3.6.7",

    "pdfkit":               "^0.15.0",
    "docx":                 "^8.5.0",
    "pptxgenjs":            "^3.12.0",
    "archiver":             "^7.0.1",

    "axios":                "^1.7.2",
    "uuid":                 "^10.0.0",
    "dayjs":                "^1.11.11",
    "crypto-js":            "^4.2.0",
    "zod":                  "^3.23.8",
    "winston":              "^3.13.0",
    "dotenv":               "^16.4.5",
    "node-cron":            "^3.0.3"
  },
  "devDependencies": {
    "nodemon":   "^3.1.4",
    "jest":      "^29.7.0",
    "eslint":    "^9.6.0",
    "prettier":  "^3.3.2",
    "supertest": "^7.0.0"
  }
}
