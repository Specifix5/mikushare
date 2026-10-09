import { eq } from 'drizzle-orm';
import { db, getUser, withTransaction } from '../db/client';
import { files, users, collections } from '../db/schema';
import { generateToken } from './tokens';

export const rotateKey = async (user: string): Promise<string | null> => {
  const token = generateToken();
  const result = await db
    .update(users)
    .set({ apiKey: token })
    .where(eq(users.user, user))
    .returning({ id: users.id });
  return result.length ? token : null;
};

export const removeAccount = async (user: string): Promise<boolean> => {
  if (user === 'anonymous') throw new Error('Cannot delete the anonymous user');
  return withTransaction(async (tx) => {
    const account = await getUser(tx, user);
    if (!account) return false;
    const anonymous = await getUser(tx, 'anonymous');
    if (!anonymous) throw new Error('Anonymous account is missing');
    await tx
      .update(files)
      .set({ ownerId: anonymous.id })
      .where(eq(files.ownerId, account.id));
    await tx
      .update(collections)
      .set({ ownerId: anonymous.id })
      .where(eq(collections.ownerId, account.id));
    await tx.delete(users).where(eq(users.id, account.id));
    return true;
  });
};
