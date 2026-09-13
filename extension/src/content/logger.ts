/**
 * Client-side Error Logger
 * ─────────────────────────
 * Sends errors/warnings to the backend /log endpoint silently.
 * Also patches window.onerror and unhandledrejection globally.
 */

const BACKEND_LOG_URL = 'https://inpromptu-backend.onrender.com/log';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  stack?: string;
  url?: string;
  userId?: string;
  timestamp: string;
}

function send(entry: LogEntry): void {
  // Fire-and-forget — never throw, never block
  fetch(BACKEND_LOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => {
    // If backend is down, just log to console
    console.warn('[Inpromptu Logger] Backend log endpoint unreachable');
  });
}

function makeEntry(level: LogLevel, message: string, context?: string, err?: Error): LogEntry {
  return {
    level,
    message,
    context,
    stack: err?.stack,
    url: window.location.href,
    timestamp: new Date().toISOString(),
  };
}

export const pcLogger = {
  error(message: string, context?: string, err?: Error): void {
    console.error(`[Inpromptu] ${message}`, err ?? '');
    send(makeEntry('error', message, context, err));
  },
  warn(message: string, context?: string): void {
    console.warn(`[Inpromptu] ${message}`);
    send(makeEntry('warn', message, context));
  },
  info(message: string, context?: string): void {
    console.log(`[Inpromptu] ${message}`);
    send(makeEntry('info', message, context));
  },
  debug(message: string, context?: string): void {
    console.debug(`[Inpromptu] ${message}`);
    if (process.env.NODE_ENV !== 'production') {
      send(makeEntry('debug', message, context));
    }
  },
};

// ── Global error capture ──────────────────────────────────────────────────────

export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    pcLogger.error(
      `Uncaught: ${event.message}`,
      `${event.filename}:${event.lineno}`,
      event.error instanceof Error ? event.error : undefined
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason instanceof Error
      ? event.reason.message
      : String(event.reason);
    pcLogger.error(`Unhandled promise rejection: ${msg}`, 'promise', event.reason instanceof Error ? event.reason : undefined);
  });
}
