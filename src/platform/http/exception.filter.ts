import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../../shared/domain/errors.js';
import { ApplicationError } from '../errors/application-error.js';
import { getLogContext } from '../logging/log-context.js';
import { logger } from '../logging/logger.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    correlationId?: string;
    details?: unknown;
  };
}

/**
 * Single place that maps application/domain failures to HTTP status codes:
 *
 *   400 invalid payload (also domain validation at ingress)
 *   401/403 reserved for the auth extension point
 *   404 resource not found
 *   409 idempotency / external id / wallet uniqueness conflicts
 *   422 business rejection (returned by controllers, not by this filter)
 *   503 transient infrastructure failure
 *   500 unexpected programming error
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = getLogContext().correlationId;

    if (exception instanceof ApplicationError) {
      response.status(exception.httpStatus).json(this.body(exception.code, exception.message, correlationId, exception.details));
      return;
    }

    if (exception instanceof DomainError) {
      response
        .status(HttpStatus.BAD_REQUEST)
        .json(this.body(exception.code, exception.message, correlationId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message = typeof payload === 'string' ? payload : exception.message;
      response.status(status).json(this.body(`HTTP_${status}`, message, correlationId));
      return;
    }

    logger.error({ err: exception }, 'unhandled exception');
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(this.body('INTERNAL_ERROR', 'Unexpected internal error', correlationId));
  }

  private body(code: string, message: string, correlationId?: string, details?: unknown): ErrorBody {
    const body: ErrorBody = { error: { code, message } };
    if (correlationId !== undefined) {
      body.error.correlationId = correlationId;
    }
    if (details !== undefined) {
      body.error.details = details;
    }
    return body;
  }
}
