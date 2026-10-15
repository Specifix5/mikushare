import { writeBarcode } from 'zxing-wasm/writer';
import { getCacheControl } from '../files/routes';

export const makeQrSvg = async (opts: {
  text: string;
  scale?: number;
}): Promise<string> => {
  const { text, scale = 1 } = opts;
  const { svg } = await writeBarcode(text, {
    format: 'QRCode',
    scale,
    withQuietZones: true,
    ecLevel: 'H',
  });

  if (!svg) {
    throw new Error('Failed to generate QR code SVG');
  }

  // SVG images cannot inherit the page's currentColor. Use the normal text
  // color explicitly, removing the white background rather than tinting it.
  return svg
    .replace('<svg ', '<svg shape-rendering="crispEdges" ')
    .replace(/<rect\b[^>]*\bfill="(?:#fff(?:fff)?|white)"[^>]*\/?\s*>/gi, '')
    .replace(/fill="(?:black|#000(?:000)?)"/gi, 'fill="#cdd6f4"');
};

export const qrCodeHandler = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const text = url.searchParams.get('text');
  const scale = Number(url.searchParams.get('scale') ?? 1);
  if (!Number.isInteger(scale) || scale < 1 || scale > 8)
    return new Response(
      'Bad Request, scale must be an integer between 1 and 8',
      { status: 400 },
    );

  if (!text?.trim() || text.length > 512)
    return new Response('Bad Request, text must be between 1 and 512 chars', {
      status: 400,
    });

  const svg = await makeQrSvg({ text: text.trim(), scale });

  if (!svg)
    return new Response('Server failed to create QR code', {
      status: 500,
    });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; utf-8',
      'Cache-Control': getCacheControl(false),
    },
  });
};
