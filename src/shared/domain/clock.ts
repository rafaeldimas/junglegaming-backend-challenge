export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
