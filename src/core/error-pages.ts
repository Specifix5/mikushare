export const wantsErrorPage = (request: Request) =>
  request.method === 'GET' &&
  (request.headers.get('accept') ?? '').includes('text/html');

export const errorPage = (status: 404 | 500) =>
  new Response(Bun.file(`dist/pages/${status}.html`), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
