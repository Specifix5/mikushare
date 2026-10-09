const MAX_JSON_BYTES = 16 * 1024;

// Metadata endpoints must not inherit the much larger binary upload allowance.
export const readJsonObject = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > MAX_JSON_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
};
