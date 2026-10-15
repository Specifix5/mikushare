import { shareControls } from '../ui/file-components.js';

document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('collectionStatus');
  if (!status) return;
  const key = location.pathname.split('/')[2];
  const zip = document.getElementById('collectionZip');
  const rows = document.getElementById('collectionFiles');
  const entries = new Map();
  let refreshVersion = 0;
  let currentCollection = null;
  let active = true;
  let zipRefreshing = false;
  const formatDate = (date) =>
    date ? new Date(date).toLocaleString() : 'Unavailable';
  const formatBytes = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
  };
  const collectionControls = shareControls(
    document.getElementById('collectionActions'),
    document.getElementById('collectionLink'),
    document.getElementById('collectionQR'),
  );
  const createEntry = () => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.setAttribute('role', 'row');
    const link = document.createElement('a');
    link.className = 'file-link';
    const size = document.createElement('span');
    size.className = 'file-size';
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const download = document.createElement('a');
    download.textContent = '[ download ]';
    actions.append(download);
    const dates = document.createElement('p');
    dates.className = 'collection-file-info';
    const checksum = document.createElement('details');
    checksum.className = 'file-checksum';
    const label = document.createElement('summary');
    const value = document.createElement('code');
    checksum.append(label, value);
    const unavailable = document.createElement('p');
    unavailable.className = 'file-status';
    unavailable.textContent = 'Unavailable (expired or deleted)';
    const log = document.createElement('p');
    log.className = 'file-status';
    const qr = document.createElement('div');
    qr.className = 'file-qr';
    const actionsState = shareControls(actions, log, qr);
    row.append(link, size, actions, dates, checksum, unavailable, log, qr);
    return {
      row,
      link,
      size,
      dates,
      checksum,
      label,
      value,
      unavailable,
      actionsState,
      download,
    };
  };
  const refresh = async () => {
    const version = ++refreshVersion;
    try {
      const response = await fetch(
        `/collections/${encodeURIComponent(key)}/info`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('This collection is unavailable.');
      const collection = await response.json();
      if (version !== refreshVersion || !active) return currentCollection;
      currentCollection = collection;
      document.getElementById('collectionTitle').textContent = collection.name;
      document.title = collection.name;
      zip.hidden = !collection.zip;
      if (collection.zip) zip.href = collection.zip;
      else zip.removeAttribute('href');
      collectionControls.update(collection.url, collection.name);
      const keys = new Set();
      for (const [index, file] of collection.files.entries()) {
        keys.add(file.key);
        let entry = entries.get(file.key);
        if (!entry) {
          entry = createEntry();
          entries.set(file.key, entry);
        }
        entry.link.textContent = file.name;
        entry.link.title = file.name;
        if (file.available) {
          entry.link.href = file.pageUrl || file.shareUrl;
          entry.download.href = file.url;
        } else {
          entry.link.removeAttribute('href');
          entry.download.removeAttribute('href');
        }
        entry.download.hidden = !file.available;
        entry.size.textContent = formatBytes(file.size);
        entry.dates.textContent = `Uploaded: ${formatDate(file.createdAt)} · Expires: ${file.expiresAt ? formatDate(file.expiresAt) : 'Never'}`;
        entry.checksum.hidden = !file.sha256;
        entry.label.textContent = file.sha256
          ? `SHA-256 ${file.sha256.slice(0, 12)}…`
          : '';
        entry.value.textContent = file.sha256 || '';
        entry.unavailable.hidden = file.available;
        entry.actionsState.update(file.pageUrl || file.shareUrl, file.name);
        if (rows.children[index] !== entry.row) {
          rows.insertBefore(entry.row, rows.children[index] || null);
        }
      }
      for (const [fileKey, entry] of entries) {
        if (keys.has(fileKey)) continue;
        entry.actionsState.dispose();
        entry.row.remove();
        entries.delete(fileKey);
      }
      const available = collection.files.filter(
        (file) => file.available,
      ).length;
      const totalBytes = collection.files.reduce(
        (sum, file) => sum + file.size,
        0,
      );
      document.getElementById('collectionInfo').textContent =
        `Uploaded: ${formatDate(collection.createdAt)} · ${collection.files.length} file${collection.files.length === 1 ? '' : 's'} (${available} available) · ${formatBytes(totalBytes)} total`;
      zip.textContent = `[ download ${available} file${available === 1 ? '' : 's'} as zip ]`;
      status.textContent = '';
      status.classList.remove('error');
      return collection;
    } catch (error) {
      if (version !== refreshVersion || !active) return currentCollection;
      throw error;
    }
  };
  const failed = (error) => {
    if (!active) return;
    status.textContent = error.message;
    status.classList.add('error');
  };
  zip.addEventListener('click', async (event) => {
    event.preventDefault();
    if (zipRefreshing) return;
    zipRefreshing = true;
    zip.setAttribute('aria-busy', 'true');
    try {
      // Refresh before navigating; automated clients must supply their own rev.
      const collection = await refresh();
      if (collection?.zip) location.assign(collection.zip);
    } catch (error) {
      failed(error);
    } finally {
      zipRefreshing = false;
      zip.removeAttribute('aria-busy');
    }
  });
  refresh().catch(failed);
  const startTimer = () =>
    setInterval(() => {
      if (!zipRefreshing) refresh().catch(failed);
    }, 30000);
  let timer = startTimer();
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    active = true;
    refresh().catch(failed);
    clearInterval(timer);
    timer = startTimer();
  });
  window.addEventListener('pagehide', () => {
    active = false;
    clearInterval(timer);
    collectionControls.dispose();
    for (const entry of entries.values()) entry.actionsState.dispose();
  });
});
