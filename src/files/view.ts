// Navigation headers work for new browsers without relying solely on their UA.
export const wantsFilePage = (request: Request) => {
  const url = new URL(request.url);
  if (url.searchParams.get('download') === '1' || request.headers.has('range'))
    return false;
  if (url.searchParams.get('view') === '1') return true;
  const destination = request.headers.get('sec-fetch-dest');
  if (destination && !['document', 'iframe', 'empty'].includes(destination))
    return false;
  if (destination === 'document' || destination === 'iframe') return true;
  const accept = request.headers.get('accept') ?? '';
  if (accept && accept !== '*/*')
    return accept.split(',').some((part) => {
      const [type, ...parameters] = part.trim().split(';');
      const quality = parameters.find((value) => value.trim().startsWith('q='));
      return (
        type === 'text/html' && (!quality || Number(quality.split('=')[1]) > 0)
      );
    });
  return /Mozilla\/|Firefox\/|Chrome\/|Safari\/|Opera\/|Edg\//i.test(
    request.headers.get('user-agent') ?? '',
  );
};

export const fileKind = (mime: string) => {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (
    /^image\/(png|jpeg|webp|gif|avif|bmp|x-icon|vnd.microsoft.icon)$/.test(mime)
  )
    return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
};

// Only a single byte range is needed for browser media seeking/PDF readers.
export const byteRange = (header: string, size: number) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size ||
    (!match[1] && Number(match[2]) === 0)
  )
    return null;
  return { start, end };
};
