import { db, getUser, getUserFromKey } from '../db/client';
import { env } from './env';
import { generateToken, matchesToken } from './tokens';

interface AdminIdentity {
  user: string;
  token: string;
  account: boolean;
}
const sessions = new Map<
  string,
  { identity: AdminIdentity; expiresAt: number }
>();
const attempts = new Map<string, { count: number; expiresAt: number }>();
const SESSION_TTL = 60 * 60 * 1000;
const COOKIE_NAME = 'miku_admin';

const allowedUsers = () => env.ADMIN_USERS;
const allowedTokens = () => env.ADMIN_TOKENS;

export const adminFromToken = async (
  token: string,
): Promise<AdminIdentity | null> => {
  if (!token || token.length > 512) return null;
  const allowed = allowedTokens().find((candidate) =>
    matchesToken(token, candidate),
  );
  if (allowed) return { user: 'admin token', token: allowed, account: false };
  const account = await getUserFromKey(db, token);
  if (
    !account ||
    account.user === 'anonymous' ||
    !allowedUsers().includes(account.user)
  )
    return null;
  return { user: account.user, token: account.apiKey, account: true };
};

const validIdentity = async (identity: AdminIdentity): Promise<boolean> => {
  if (!identity.account) return allowedTokens().includes(identity.token);
  if (!allowedUsers().includes(identity.user)) return false;
  const account = await getUser(db, identity.user);
  return (
    !!account &&
    account.apiKey === identity.token &&
    (!account.expiresAt || account.expiresAt > new Date())
  );
};

const cookieToken = (request: Request): string | undefined =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);

const publicOrigin = () =>
  env.BASE_URL ? new URL(env.BASE_URL).origin : undefined;
const secureCookie = (request: Request) =>
  new URL(request.url).protocol === 'https:' ||
  (env.BASE_URL && new URL(env.BASE_URL).protocol === 'https:');

export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get('origin');
  return (
    origin !== null &&
    (origin === new URL(request.url).origin || origin === publicOrigin())
  );
};

export const getAdmin = async (
  request: Request,
): Promise<AdminIdentity | null> => {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    return token ? adminFromToken(token) : null;
  }
  const token = cookieToken(request);
  if (!token) return null;
  const key = token;
  const session = sessions.get(key);
  if (!session) return null;
  if (
    session.expiresAt <= Date.now() ||
    !(await validIdentity(session.identity))
  ) {
    sessions.delete(key);
    return null;
  }
  if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request))
    return null;
  return session.identity;
};

export const allowLogin = (address: string): boolean => {
  const now = Date.now();
  for (const [key, value] of attempts)
    if (value.expiresAt <= now) attempts.delete(key);
  let attempt = attempts.get(address);
  if (!attempt) {
    if (attempts.size >= 10000) return false;
    attempt = { count: 0, expiresAt: now + 15 * 60 * 1000 };
    attempts.set(address, attempt);
  }
  attempt.count++;
  return attempt.count <= 10;
};

export const startAdminSession = (
  identity: AdminIdentity,
  request: Request,
): string => {
  for (const [key, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(key);
  }
  if (sessions.size >= 10000) throw new Error('Too many active sessions');
  const token = generateToken();
  sessions.set(token, {
    identity,
    expiresAt: Date.now() + SESSION_TTL,
  });
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/adminpane; Max-Age=3600${secureCookie(request) ? '; Secure' : ''}`;
};

export const endAdminSession = (request: Request): string => {
  const token = cookieToken(request);
  if (token) sessions.delete(token);
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/adminpane; Max-Age=0${secureCookie(request) ? '; Secure' : ''}`;
};
