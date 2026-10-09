import { createHash } from 'crypto';

export const hashFile = async (file: Blob): Promise<string> => {
  const hash = createHash('sha256');
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest('hex');
};
