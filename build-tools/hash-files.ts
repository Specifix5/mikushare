import 'dotenv/config';
import { eq, isNull } from 'drizzle-orm';
import path from 'path';
import { db } from '../src/db/client';
import { files } from '../src/db/schema';
import { UPLOADS_DIR } from '../src/utils/constants';
import { hashFile } from '../src/utils/hashing';

let count = 0;
const rows = await db.select().from(files).where(isNull(files.sha256));
for (const file of rows) {
  const filepath = path.join(
    UPLOADS_DIR,
    file.expiresAt ? 'temp' : '',
    file.filename,
  );
  if (!(await Bun.file(filepath).exists())) {
    console.warn(`Skipping missing file #${file.id}`);
    continue;
  }
  const sha256 = await hashFile(Bun.file(filepath));
  await db.update(files).set({ sha256 }).where(eq(files.id, file.id));
  count++;
}
console.log(`Calculated SHA-256 for ${count} existing files.`);
process.exit(0);
