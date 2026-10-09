import { randomBytes, timingSafeEqual } from 'crypto';

export const generateToken = (): string =>
  randomBytes(32).toString('base64url');

export const matchesToken = (token: string, expectedToken: string): boolean => {
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
