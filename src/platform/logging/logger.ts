import { LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';
import { getLogContext } from './log-context.js';

function createPino(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'jungle-wagering-processor' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin() {
      return getLogContext();
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.money',
        '*.amount',
        '*.balanceBefore',
        '*.balanceAfter',
      ],
      censor: '[REDACTED]',
    },
  });
}

export const logger = createPino();

/**
 * Routes Nest's own logs through pino so every line is structured JSON with
 * the active correlation fields.
 */
export class PinoLoggerService implements LoggerService {
  log(message: unknown, context?: string): void {
    logger.info({ context }, stringify(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    logger.error({ context, stack }, stringify(message));
  }

  warn(message: unknown, context?: string): void {
    logger.warn({ context }, stringify(message));
  }

  debug(message: unknown, context?: string): void {
    logger.debug({ context }, stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    logger.trace({ context }, stringify(message));
  }
}

function stringify(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
