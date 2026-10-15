import { parseFile, selectCover } from 'music-metadata';
import exifr from 'exifr';
import { stat } from 'fs/promises';

export interface MetadataRow {
  label: string;
  value: string;
}
interface MediaMetadata {
  rows: MetadataRow[];
  title?: string;
  artist?: string;
  cover?: { type: string; data: Uint8Array };
  note?: string;
}

// Exclude binary payloads (artwork, thumbnails, maker notes); display readable tags.
export const metadataRows = (input: unknown): MetadataRow[] => {
  const rows: MetadataRow[] = [];
  let remaining = 256 * 1024;
  const walk = (value: unknown, label: string, depth: number) => {
    if (
      value === null ||
      value === undefined ||
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      depth > 8 ||
      rows.length >= 500 ||
      remaining <= 0
    )
      return;
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime()))
        walk(value.toISOString(), label, depth);
    } else if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/^(picture|data|MakerNote|UserCommentRaw|thumbnail)$/i.test(key))
          continue;
        walk(child, label ? `${label} / ${key}` : key, depth + 1);
      }
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      const text = String(value).slice(0, Math.min(4096, remaining));
      if (text) {
        rows.push({ label, value: text });
        remaining -= text.length;
      }
    }
  };
  walk(input, '', 0);
  return rows;
};

const cache = new Map<string, { stamp: string; value: MediaMetadata }>();
const pending = new Map<string, Promise<MediaMetadata>>();
const empty = (note: string): MediaMetadata => ({ rows: [], note });

export const readMediaMetadata = async (
  filepath: string,
  kind: string,
): Promise<MediaMetadata> => {
  if (!['audio', 'image', 'video'].includes(kind)) return { rows: [] };
  const stats = await stat(filepath);
  const stamp = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  const cached = cache.get(filepath);
  if (cached?.stamp === stamp) {
    cache.delete(filepath);
    cache.set(filepath, cached);
    return cached.value;
  }
  const existing = pending.get(filepath);
  if (existing) return existing;
  if (pending.size >= 2)
    return empty('Metadata reader is busy. Reload to try again.');
  const task = (async (): Promise<MediaMetadata> => {
    try {
      if (kind === 'image') {
        const tags: unknown = await exifr.parse(filepath, {
          tiff: true,
          xmp: true,
          icc: true,
          iptc: true,
          jfif: false,
          ihdr: false,
          mergeOutput: false,
        });
        return { rows: metadataRows(tags) };
      }
      const metadata = await parseFile(filepath, { duration: false });
      const cover = selectCover(metadata.common.picture);
      const type = cover?.format === 'image/jpg' ? 'image/jpeg' : cover?.format;
      return {
        title: metadata.common.title,
        artist: metadata.common.artist,
        rows: metadataRows({
          tags: metadata.common,
          native: metadata.native,
        }),
        ...(cover &&
        type &&
        /^image\/(jpeg|png|webp|gif)$/.test(type) &&
        cover.data.length <= 2 * 1024 * 1024
          ? { cover: { type, data: cover.data } }
          : {}),
      };
    } catch {
      return empty(
        'Embedded metadata could not be read. The original file is still available.',
      );
    }
  })();
  pending.set(filepath, task);
  try {
    const value = await task;
    if (cache.size >= 24) cache.delete(cache.keys().next().value!);
    cache.set(filepath, { stamp, value });
    return value;
  } finally {
    pending.delete(filepath);
  }
};
