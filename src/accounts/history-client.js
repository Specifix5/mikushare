import { shareControls } from '../ui/file-components.js';
import { storedHistoryToken, clearHistoryToken } from './access.js';

document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('historyStatus');
  const rows = document.getElementById('historyFiles');
  const previous = document.getElementById('historyPrev');
  const next = document.getElementById('historyNext');
  const refresh = document.getElementById('historyRefresh');
  let offset = 0,
    version = 0;
  const load = async () => {
    const current = ++version;
    rows.replaceChildren();
    previous.hidden = next.hidden = true;
    status.textContent = 'Loading files...';
    const token = storedHistoryToken();
    if (!token) {
      status.textContent =
        'Enter your private account token on the home page to view previous files.';
      return;
    }
    try {
      const response = await fetch(`/account/files?offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (current !== version) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          clearHistoryToken();
        throw new Error(await response.text());
      }
      const data = await response.json();
      if (current !== version) return;
      for (const file of data.entries) {
        const row = document.createElement('div');
        row.className = 'file-row';
        row.setAttribute('role', 'row');
        const link = document.createElement('a');
        link.className = 'file-link';
        link.href = file.url;
        link.textContent =
          (file.kind === 'collection' ? '[ folder ] ' : '') + file.name;
        const size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = `${(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        if (file.downloadUrl) {
          const download = document.createElement('a');
          download.href = file.downloadUrl;
          download.textContent = '[ download ]';
          actions.append(download);
        }
        const info = document.createElement('p');
        info.className = 'collection-file-info';
        info.textContent = `Uploaded: ${new Date(file.createdAt).toLocaleString()} ? ${file.kind === 'collection' ? `${file.count} files` : `Expires: ${file.expiresAt ? new Date(file.expiresAt).toLocaleString() : 'Never'}`}`;
        const share = document.createElement('p');
        share.className = 'file-status';
        const qr = document.createElement('div');
        qr.className = 'file-qr';
        shareControls(actions, share, qr).update(file.url, file.name);
        row.append(link, size, actions, info, share, qr);
        rows.append(row);
      }
      status.textContent = data.entries.length ? '' : 'No previous files.';
      previous.hidden = offset === 0;
      next.hidden = !data.hasMore;
    } catch (error) {
      if (current === version) status.textContent = error.message;
    }
  };
  previous.addEventListener('click', () => {
    offset = Math.max(0, offset - 50);
    void load();
  });
  next.addEventListener('click', () => {
    offset += 50;
    void load();
  });
  refresh.addEventListener('click', () => void load());
  // Re-check access after returning from a collection, including a cached page.
  window.addEventListener('pageshow', () => void load());
  window.addEventListener('pagehide', () => {
    version++;
    rows.replaceChildren();
  });
  void load();
});
