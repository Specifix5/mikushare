import { writeBarcode } from 'zxing-wasm/writer';
import { getCacheControl } from './getFile';

export const makeQrSvg = async (opts: {
  text: string;
  scale?: number;
}): Promise<string> => {
  const { text, scale = 1 } = opts;
  const { svg } = await writeBarcode(text, {
    format: 'QRCode',
    scale,
    withQuietZones: false,
    ecLevel: 'H',
  });

  if (!svg) {
    throw new Error('Failed to generate QR code SVG');
  }

  const tinted = svg
    .replace('<svg ', '<svg shape-rendering="crispEdges" ')
    .replace(
      /<svg[^>]*>/,
      (m) => `${m}<style>.d{fill:currentColor;fill-opacity:.7}</style>`,
    )
    .replace(/fill="black"|fill="#000000?"/g, 'class="d"'); // override fills
  return tinted;
};

export const qrCodeHandler = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const text = url.searchParams.get('text');
  const scale = Number(url.searchParams.get('scale')) || 1;

  if (!text || text.length < 1 || text.length > 512)
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
