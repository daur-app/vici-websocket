import "dotenv/config";
import * as Sentry from "@sentry/node";

const isProduction = process.env.NODE_ENV !== "development";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: isProduction,
  environment: process.env.NODE_ENV || "development",

  // Send request headers, IP, user data with events
  sendDefaultPii: true,

  // Errors only — no performance tracing (saves free-tier quota)
  tracesSampleRate: 0,

  // Filter noisy errors that aren't actionable
  ignoreErrors: [
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
  ],
});

export { Sentry };
