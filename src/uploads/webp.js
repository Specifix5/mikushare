const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
]);

export const canConvertToWebP = (file) =>
  imageTypes.has(file.type.toLowerCase()) ||
  (!file.type && /\.(png|jpe?g|webp|bmp)$/i.test(file.name));

export const webpFilename = (name) => name.replace(/\.[^.]+$/, '') + '.webp';

const isAnimated = async (file) => {
  const header = new Uint8Array(await file.slice(0, 30).arrayBuffer());
  const text = (bytes) => new TextDecoder().decode(bytes);
  if (
    text(header.slice(0, 4)) === 'RIFF' &&
    text(header.slice(8, 12)) === 'WEBP'
  )
    return text(header.slice(12, 16)) === 'VP8X' && !!(header[20] & 2);
  if (header[0] !== 137 || text(header.slice(1, 4)) !== 'PNG') return false;
  // APNG declares animation before the first image-data chunk.
  for (let offset = 8; offset + 8 <= file.size; ) {
    const bytes = await file.slice(offset, offset + 8).arrayBuffer();
    const type = text(new Uint8Array(bytes, 4));
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += new DataView(bytes).getUint32(0) + 12;
  }
  return false;
};

export const convertToWebP = async (file, quality) => {
  if (typeof createImageBitmap !== 'function')
    throw new Error('Image conversion is unavailable in this browser.');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new Error('WebP quality must be between 1 and 100%.');
  if (await isAnimated(file))
    throw new Error(
      'Animated images cannot be converted here. Uncheck Save as WebP to keep the animation.',
    );
  let bitmap;
  const canvas = document.createElement('canvas');
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 32_000_000)
      throw new Error(
        'Image is too large to convert here (maximum 32 megapixels).',
      );
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context)
      throw new Error('Image conversion is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality / 100),
    );
    if (!blob || blob.type !== 'image/webp')
      throw new Error('WebP conversion is unavailable in this browser.');
    return new File([blob], webpFilename(file.name), {
      type: 'image/webp',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap?.close();
    canvas.width = canvas.height = 0;
  }
};
