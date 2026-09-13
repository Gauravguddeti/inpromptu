/**
 * Structured Logger — Winston
 * ────────────────────────────
 * - Console output (colorized in dev)
 * - Daily rotating file logs in /logs/
 * - Separate error.log for errors only
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${stack ?? message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console — colorized
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss' }),
        logFormat
      ),
    }),

    // All logs — daily rotating
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '7d',
    }),

    // Errors only
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '10m',
      maxFiles: '14d',
    }),
  ],
});

// ─── Client-side error ingestion ──────────────────────────────────────────────

export interface ClientLogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  context?: string;
  stack?: string;
  url?: string;
  userId?: string;
  timestamp: string;
}

export function logClientEntry(entry: ClientLogEntry): void {
  const meta = {
    source: 'client',
    url: entry.url,
    userId: entry.userId ? `${entry.userId.slice(0, 8)}...` : undefined,
    context: entry.context,
  };

  switch (entry.level) {
    case 'error':
      logger.error(`[CLIENT] ${entry.message}${entry.stack ? `\n${entry.stack}` : ''}`, meta);
      break;
    case 'warn':
      logger.warn(`[CLIENT] ${entry.message}`, meta);
      break;
    default:
      logger.info(`[CLIENT] ${entry.message}`, meta);
  }
}
