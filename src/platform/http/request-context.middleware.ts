import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { runWithLogContext } from '../logging/log-context.js';
import { logger } from '../logging/logger.js';

const CORRELATION_HEADER = 'x-correlation-id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header(CORRELATION_HEADER);
    const correlationId =
      header !== undefined && header.length > 0 && header.length <= 128
        ? header
        : uuidv7();

    res.setHeader(CORRELATION_HEADER, correlationId);

    runWithLogContext({ correlationId }, () => {
      const startedAt = performance.now();
      res.on('finish', () => {
        logger.info(
          {
            http: {
              method: req.method,
              path: req.originalUrl.split('?')[0],
              statusCode: res.statusCode,
              durationMs: Math.round(performance.now() - startedAt),
            },
          },
          'http request completed',
        );
      });
      next();
    });
  }
}
