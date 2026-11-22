import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

export interface Config {
  host: string; port: number; dataDir: string; databaseUrl: string;
  embeddedWorker: boolean; frontendOrigin: string; sessionHours: number;
  model?: { baseUrl: string; name: string; apiKey: string; timeoutMs: number };
}
export function configFromEnv(): Config {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: z.coerce.number().int().min(1).max(65535).parse(process.env.PORT || 3080),
    dataDir: path.resolve(process.env.DATA_DIR || './storage'),
    databaseUrl: process.env.DATABASE_URL || '',
    embeddedWorker: process.env.EMBEDDED_WORKER !== 'false',
    frontendOrigin: process.env.FRONTEND_ORIGIN || '',
    sessionHours: z.coerce.number().int().min(1).max(168).parse(process.env.SESSION_HOURS || 24),
    model: process.env.MODEL_BASE_URL && process.env.MODEL_NAME && process.env.MODEL_API_KEY ? {
      baseUrl: z.url().parse(process.env.MODEL_BASE_URL).replace(/\/+$/,''),
      name: z.string().max(200).parse(process.env.MODEL_NAME), apiKey: process.env.MODEL_API_KEY,
      timeoutMs: z.coerce.number().int().min(100).max(120000).parse(process.env.MODEL_TIMEOUT_MS || 30000)
    } : undefined
  };
}
