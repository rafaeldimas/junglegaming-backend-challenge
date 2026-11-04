/**
 * Bun test preload.
 *
 * - keeps the test output readable by silencing the application logger;
 * - stubs `ssh2`, which Testcontainers imports eagerly for remote Docker
 *   hosts. Its native binding crashes Bun 1.4.4 while loading; the suite only
 *   talks to the local Docker socket, so the stub is never used.
 */
import { mock } from 'bun:test';

process.env.LOG_LEVEL ??= 'silent';

await mock.module('ssh2', () => ({
  Client: class Client {},
  default: { Client: class Client {} },
}));
