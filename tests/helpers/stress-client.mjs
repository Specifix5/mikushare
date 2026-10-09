// External Node clients keep the load generator separate from Bun's HTTP server.
import { readFile } from 'node:fs/promises';

const base = process.env.MIKU_STRESS_BASE;
const specs = JSON.parse(process.env.MIKU_STRESS_SPECS);
const directory = process.env.MIKU_STRESS_DIR;
const buffers = await Promise.all(
  [0, 1].map((index) => readFile(`${directory}/payload-${index}.bin`)),
);
const metrics = new Map();
const statuses = new Map();
const rssBaselineMiB = process.memoryUsage().rss / 1024 / 1024;
let rssPeakMiB = rssBaselineMiB;
const sampler = setInterval(() => {
  rssPeakMiB = Math.max(rssPeakMiB, process.memoryUsage().rss / 1024 / 1024);
}, 25);

const call = async (route, options, kind) => {
  const start = performance.now();
  let response;
  try {
    response = await fetch(base + route, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`${options.method} ${route}: ${error.message}`, {
      cause: error,
    });
  }
  const values = metrics.get(kind) ?? [];
  values.push(performance.now() - start);
  metrics.set(kind, values);
  statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  if (response.status >= 400)
    throw new Error(
      `${options.method} ${route}: ${response.status} ${await response.text()}`,
    );
  return response;
};

const results = await Promise.allSettled(
  specs.map(async (spec) => {
    const bytes = buffers[spec.group];
    const headers = { Authorization: `Bearer ${spec.token}` };
    if (!spec.chunked) {
      const body = new FormData();
      body.append('file', new File([bytes], spec.name));
      return (
        await call('/upload', { method: 'POST', headers, body }, 'legacy')
      ).json();
    }
    const session = await (
      await call(
        '/ui-upload',
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [{ name: spec.name, size: bytes.length }],
          }),
        },
        'manifest',
      )
    ).json();
    const chunkCount = Math.ceil(bytes.length / session.chunkSize);
    // Two chunks per fixture, below the server's three-connection session cap.
    await Promise.all(
      Array.from({ length: chunkCount }, (_, index) =>
        call(
          `/ui-upload/${session.id}/0/${index}`,
          {
            method: 'PUT',
            headers,
            body: new Blob([
              bytes.subarray(
                index * session.chunkSize,
                (index + 1) * session.chunkSize,
              ),
            ]),
          },
          'chunk',
        ),
      ),
    );
    return (
      await call(
        `/ui-upload/${session.id}/complete`,
        { method: 'POST', headers },
        'complete',
      )
    ).json();
  }),
);
clearInterval(sampler);
console.log(
  JSON.stringify({
    results: results.map((item, index) =>
      item.status === 'fulfilled'
        ? { status: 'fulfilled', value: item.value }
        : {
            status: 'rejected',
            reason: `${specs[index].name}: ${String(item.reason)}`,
          },
    ),
    metrics: Object.fromEntries(metrics),
    statuses: Object.fromEntries(statuses),
    rssBaselineMiB,
    rssPeakMiB,
  }),
);
