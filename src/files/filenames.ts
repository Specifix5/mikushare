// Safe, portable ASCII names for downloads, renames, headers and ZIP entries.
export const normalizeFilename = (name: string, fallback = 'file'): string => {
  const value = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/^\.+|[. _]+$/g, '');
  const match = /^(.*?)(\.[a-zA-Z0-9]{1,16})?$/.exec(value);
  let base = (match?.[1] ?? '').replace(/^_+|_+$/g, '') || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = '_' + base;
  const extension = match?.[2] ?? '';
  return base.slice(0, 150 - extension.length) + extension;
};

export const contentDisposition = (
  name: string,
  attachment = false,
): string => {
  const safe = normalizeFilename(name);
  return `${attachment ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`;
};

export const uniqueFilenames = (names: string[]): string[] => {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = normalizeFilename(name);
    const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(safe)?.[0] ?? '';
    const base = extension ? safe.slice(0, -extension.length) : safe;
    let result = safe;
    let suffix = 2;
    while (used.has(result.toLowerCase()))
      result = `${base.slice(0, 130)}_${suffix++}${extension}`;
    used.add(result.toLowerCase());
    return result;
  });
};
