/**
 * POST /log — Client-side error ingestion endpoint
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logClientEntry } from '../lib/logger';

const router = Router();

const LogSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']),
  message: z.string().max(2000),
  context: z.string().max(200).optional(),
  stack: z.string().max(5000).optional(),
  url: z.string().max(500).optional(),
  userId: z.string().max(50).optional(),
  timestamp: z.string(),
});

router.post('/', (req: Request, res: Response) => {
  const parsed = LogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid log entry' });
    return;
  }

  logClientEntry(parsed.data);

  // Broadcast to all SSE subscribers (the demo dashboard)
  broadcastLogEntry({ ...parsed.data, source: 'client' });

  res.json({ ok: true });
});

// GET /log/stream — Server-Sent Events for real-time log monitoring in demo dashboard
router.get('/stream', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Store subscriber
  logStreamSubscribers.add(res);
  res.write('data: {"type":"connected"}\n\n');

  _req.on('close', () => {
    logStreamSubscribers.delete(res);
  });
});

// In-memory subscriber set for SSE streaming
export const logStreamSubscribers = new Set<Response>();

export function broadcastLogEntry(entry: object): void {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  logStreamSubscribers.forEach((sub) => {
    try {
      sub.write(data);
    } catch {
      logStreamSubscribers.delete(sub);
    }
  });
}

export default router;
