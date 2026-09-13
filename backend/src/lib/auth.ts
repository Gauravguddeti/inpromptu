/**
 * Auth middleware — verifies Supabase JWT
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

const SUPABASE_URL = 'https://bakcqcfmikaiifgcwllq.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// JWK client for Supabase JWT verification
const jwksClient = jwksRsa({
  jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 3600000, // 1 hour
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  jwt.verify(
    token,
    getKey,
    {
      audience: 'authenticated',
      issuer: `${SUPABASE_URL}/auth/v1`,
    },
    (err, decoded) => {
      if (err) {
        // Fallback: try verifying with service role key (for dev/testing)
        try {
          const payload = jwt.verify(token, SERVICE_ROLE_KEY) as jwt.JwtPayload;
          req.userId = payload.sub;
          req.userEmail = payload.email as string | undefined;
          next();
          return;
        } catch {
          res.status(401).json({ error: 'Invalid token' });
          return;
        }
      }

      const payload = decoded as jwt.JwtPayload;
      req.userId = payload.sub;
      req.userEmail = payload.email as string | undefined;
      next();
    }
  );
}

// ─── Per-user rate limiter ─────────────────────────────────────────────────────
// Simple in-memory rate limiter (good enough for Phase 1; move to Redis for Phase 2)

interface RateEntry {
  analyzeCount: number;
  improveCount: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_ANALYZE_PER_MIN = 15;
const MAX_IMPROVE_PER_MIN = 3;

export function checkRateLimit(
  userId: string,
  type: 'analyze' | 'improve'
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(userId);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { analyzeCount: 0, improveCount: 0, windowStart: now };
    rateLimitMap.set(userId, entry);
  }

  if (type === 'analyze') {
    if (entry.analyzeCount >= MAX_ANALYZE_PER_MIN) {
      return { allowed: false, retryAfter: Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000) };
    }
    entry.analyzeCount++;
  } else {
    if (entry.improveCount >= MAX_IMPROVE_PER_MIN) {
      return { allowed: false, retryAfter: Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000) };
    }
    entry.improveCount++;
  }

  return { allowed: true };
}
