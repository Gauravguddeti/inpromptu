/**
 * Inpromptu Backend — Express Server
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { runMigration } from './lib/db';
import { logger } from './lib/logger';

import analyzeRouter from './routes/analyze';
import improveRouter from './routes/improve';
import memoryRouter from './routes/memory';
import feedbackRouter from './routes/feedback';
import logRouter from './routes/log';
import refineRouter from './routes/refine';
import contextRouter from './routes/context';

const app = express();
const PORT = process.env.PORT ?? 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*', // Open for demo + extension
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50kb' }));

// Request logger
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ─── Demo static site ─────────────────────────────────────────────────────────

app.use('/demo', express.static(path.join(process.cwd(), 'demo')));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/analyze', analyzeRouter);
app.use('/improve-full', improveRouter);
app.use('/memory', memoryRouter);
app.use('/feedback', feedbackRouter);
app.use('/log', logRouter);
app.use('/refine', refineRouter);
app.use('/context', contextRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  try {
    await runMigration();
    logger.info('DB migration complete');

    app.listen(PORT, () => {
      logger.info(`Inpromptu backend running on http://localhost:${PORT}`);
      logger.info(`Demo site: http://localhost:${PORT}/demo`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err as Error);
    process.exit(1);
  }
}

start();
