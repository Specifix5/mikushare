import { z } from 'zod';
import { MAX_TEXT_SIZE } from './constants';
import { UploadError } from './upload-stream';

export const textTitleSchema = z.string().trim().min(1).max(150);

// Bound actual bytes as well as the advertised Blob size, and reject invalid
// UTF-8 instead of silently replacing uploaded bytes in the viewer.
export const readTextContent = async (blob: Blob): Promise<string> => {
  const maximum = MAX_TEXT_SIZE * 1024 * 1024;
  if (blob.size > maximum)
    throw new UploadError(`Max text size is ${MAX_TEXT_SIZE} MB`, 413);
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0;
  let content = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum)
        throw new UploadError(`Max text size is ${MAX_TEXT_SIZE} MB`, 413);
      content += decoder.decode(chunk.value, { stream: true });
    }
    return content + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof UploadError) throw error;
    if (error instanceof TypeError)
      throw new UploadError('Text content must be valid UTF-8');
    throw error;
  } finally {
    reader.releaseLock();
  }
};
