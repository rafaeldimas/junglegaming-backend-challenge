import {
  findSqlState,
  isTransientInfrastructureError,
  isUniqueViolation,
} from './unit-of-work.js';

describe('database error classification', () => {
  it('finds a SQLSTATE through the cause chain', () => {
    expect(findSqlState({ code: '23505' })).toBe('23505');
    expect(findSqlState({ cause: { cause: { code: '40P01' } } })).toBe('40P01');
    expect(findSqlState(new Error('not a database error'))).toBeUndefined();
    expect(findSqlState(null)).toBeUndefined();
  });

  it('detects unique violations', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: '40001' })).toBe(false);
  });

  it('classifies connection-level failures as transient', () => {
    expect(isTransientInfrastructureError({ code: '08006' })).toBe(true);
    expect(isTransientInfrastructureError({ code: '08001' })).toBe(true);
    expect(isTransientInfrastructureError({ code: '57P03' })).toBe(true);
    expect(isTransientInfrastructureError({ code: '53300' })).toBe(true);
    expect(isTransientInfrastructureError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(
      isTransientInfrastructureError({ cause: { code: 'ETIMEDOUT' } }),
    ).toBe(true);
  });

  it('does not classify business or constraint errors as transient', () => {
    expect(isTransientInfrastructureError({ code: '23505' })).toBe(false);
    expect(isTransientInfrastructureError({ code: '40001' })).toBe(false);
    expect(isTransientInfrastructureError(new Error('boom'))).toBe(false);
  });
});
