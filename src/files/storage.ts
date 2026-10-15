import { lstat, realpath } from 'fs/promises';
import path from 'path';
import { UPLOADS_DIR } from '../config/constants';

// Shared availability check for collection sources and file/crawler redirects.
// A configured storage-root symlink is allowed, but child links cannot escape it.
export const isStoredFile = async (filepath: string): Promise<boolean> => {
  const root = path.resolve(UPLOADS_DIR);
  const candidate = path.resolve(filepath);
  const parent = path.dirname(candidate);
  const basename = path.basename(candidate);
  if (
    (parent !== root && parent !== path.join(root, 'temp')) ||
    /[\\/\x00-\x1f:\x7f]/.test(basename)
  )
    return false;
  try {
    if (!(await lstat(candidate)).isFile()) return false;
    const [physicalRoot, physicalFile] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    return physicalFile.startsWith(physicalRoot + path.sep);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return false;
    throw error;
  }
};
