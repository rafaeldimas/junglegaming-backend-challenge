import { z } from 'zod';

/**
 * Identifier shape shared by every UUID path parameter and body field.
 * Version-agnostic on purpose: ids are UUIDv7 today, but stored ids created
 * elsewhere (fixtures, imports) remain addressable.
 */
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must be a UUID',
  );
