const rasterTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

// User uploads never become executable pages or scripts on the site's origin.
// MIME comes from the stored path, never the request's filename or upload headers.
export const uploadContent = (mime: string, download: boolean) => {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  const media =
    rasterTypes.has(type) || /^(audio|video)\/[a-z0-9!#$&^_.+-]+$/.test(type);
  // Correct SVG MIME permits image decoding. Keep document navigations as
  // downloads; the serving route also applies sandbox/default-src CSP.
  const svg = type === 'image/svg+xml';
  return {
    type: media || svg ? type : 'application/octet-stream',
    attachment: download || !media,
  };
};
