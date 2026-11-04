import { v7 as uuidv7 } from 'uuid';

export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');

/**
 * UUIDv7 is time-ordered, which keeps B-tree indexes local and makes cursors
 * naturally stable for the ledger pagination.
 */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
