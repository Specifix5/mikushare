document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('adminStatus');
  const showStatus = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const api = async (path, options = {}) => {
    const response = await fetch(`/adminpane${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      if (response.status === 401 && document.getElementById('adminPanel')) {
        location.assign('/adminpane/login');
      }
      throw new Error(await response.text());
    }
    return response.json();
  };
  const login = document.getElementById('adminLogin');
  if (login) {
    login.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = login.querySelector('button');
      button.disabled = true;
      try {
        await api('/session', {
          method: 'POST',
          body: JSON.stringify({
            token: document.getElementById('adminToken').value.trim(),
          }),
        });
        document.getElementById('adminToken').value = '';
        location.assign('/adminpane');
      } catch (err) {
        showStatus(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
    return;
  }
  if (!document.getElementById('adminPanel')) return;
  let offset = 0;
  let loadVersion = 0;
  let preview = null;
  let previewVersion = 0;
  const cleanupForm = document.getElementById('fileCleanup');
  const cleanupOwner = document.getElementById('cleanupOwner');
  const cleanupMode = document.getElementById('cleanupMode');
  const clearPreview = () => {
    preview = null;
    previewVersion++;
    document.getElementById('cleanupPreview').hidden = true;
  };
  const formatBytes = (bytes) => {
    if (bytes === null || bytes === undefined) return 'Unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`;
  };
  const displayDate = (date) =>
    date ? new Date(date).toLocaleString() : 'Never';
  const cell = (text) => {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  };
  const button = (label, action) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'link-button';
    element.textContent = `[ ${label.toLowerCase()} ]`;
    element.addEventListener('click', async () => {
      element.disabled = true;
      try {
        await action();
      } catch (err) {
        showStatus(err.message, true);
      } finally {
        element.disabled = false;
      }
    });
    return element;
  };
  const revealToken = (token) => {
    document.getElementById('newToken').value = token;
    document.getElementById('issuedToken').hidden = false;
  };
  const load = async () => {
    const version = ++loadVersion;
    const requestedOffset = offset;
    const [users, response, stats] = await Promise.all([
      api('/api/users'),
      api(`/api/files?offset=${requestedOffset}`),
      api('/api/stats'),
    ]);
    if (version !== loadVersion) return;
    if (offset > 0 && offset >= response.total) {
      offset = Math.max(0, Math.floor((response.total - 1) / 100) * 100);
      await load();
      return;
    }
    const statsList = document.getElementById('serverStats');
    statsList.replaceChildren();
    for (const [label, value] of [
      ['Accounts', stats.accounts],
      ['Files', stats.fileCount],
      ['File sizes', formatBytes(stats.logicalBytes)],
      ['Disk storage', formatBytes(stats.physicalBytes)],
      ['Free space', formatBytes(stats.storageAvailableBytes)],
      ['Missing files', stats.missingFiles],
    ]) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const definition = document.createElement('dd');
      definition.textContent = value;
      item.append(term, definition);
      statsList.append(item);
    }
    const selectedOwner = cleanupOwner.value;
    cleanupOwner.replaceChildren(new Option('All accounts', ''));
    for (const user of users) {
      cleanupOwner.add(new Option(user.user, String(user.id)));
    }
    cleanupOwner.value = selectedOwner;
    if (cleanupOwner.value !== selectedOwner) clearPreview();
    const userTable = document.getElementById('adminUsers');
    userTable.replaceChildren();
    for (const user of users) {
      const row = document.createElement('tr');
      const actions = cell('');
      actions.className = 'admin-actions';
      actions.append(
        button('Files', () => {
          cleanupOwner.value = String(user.id);
          cleanupMode.value = 'all';
          updateCleanupFields();
          document
            .getElementById('cleanupHeading')
            .scrollIntoView({ behavior: 'smooth' });
          cleanupForm.querySelector('button').focus({ preventScroll: true });
        }),
      );
      actions.append(
        button('Rotate token', async () => {
          if (
            !confirm(
              `Replace the access token for ${user.user}? The old token will stop working.`,
            )
          )
            return;
          const result = await api(
            `/api/users/${encodeURIComponent(user.user)}/rotate`,
            { method: 'POST' },
          );
          revealToken(result.token);
          showStatus(`Token rotated for ${user.user}. Save it now.`);
        }),
      );
      if (user.user !== 'anonymous')
        actions.append(
          button('Delete account', async () => {
            if (
              !confirm(
                `Delete ${user.user}? Their files will move to anonymous.`,
              )
            )
              return;
            await api(`/api/users/${encodeURIComponent(user.user)}`, {
              method: 'DELETE',
            });
            showStatus(`Deleted ${user.user}.`);
            await load();
          }),
        );
      const visibility = cell('');
      const toggle = button(user.public ? 'public' : 'private', async () => {
        await api(`/api/users/${encodeURIComponent(user.user)}`, {
          method: 'PATCH',
          body: JSON.stringify({ public: !user.public }),
        });
        await load();
        showStatus(`Updated ${user.user}.`);
      });
      toggle.disabled = user.user === 'anonymous';
      toggle.title = 'Toggle whether this account is shared publicly';
      visibility.append(toggle);
      row.append(
        cell(user.user),
        visibility,
        cell(displayDate(user.createdAt)),
        cell(displayDate(user.expiresAt)),
        actions,
      );
      userTable.append(row);
    }
    const fileTable = document.getElementById('adminFiles');
    fileTable.replaceChildren();
    for (const file of response.files) {
      const row = document.createElement('tr');
      const name = cell('');
      name.className = 'admin-file-name';
      const link = document.createElement('a');
      link.href = file.url;
      link.textContent = file.filename || file.key;
      link.title = link.textContent;
      link.target = '_blank';
      link.rel = 'noopener';
      name.append(link);
      const checksum = cell('');
      checksum.className = 'checksum';
      if (file.sha256) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `${file.sha256.slice(0, 10)}…`;
        summary.title = 'Show complete SHA-256 checksum';
        const code = document.createElement('code');
        code.textContent = file.sha256;
        details.append(summary, code);
        checksum.append(details);
      } else checksum.textContent = 'Not calculated';
      const actions = cell('');
      actions.className = 'admin-actions';
      actions.append(
        button('Delete', async () => {
          if (!confirm(`Permanently delete ${file.filename || file.key}?`))
            return;
          await api(`/api/files/${file.id}`, { method: 'DELETE' });
          showStatus('File deleted.');
          await load();
        }),
      );
      const dates = cell(displayDate(file.createdAt));
      const expires = document.createElement('span');
      expires.className = 'admin-expiry';
      expires.textContent = `Expires: ${displayDate(file.expiresAt)}`;
      dates.append(expires);
      const owner = cell(file.owner);
      owner.title = file.owner;
      row.append(
        name,
        owner,
        cell(formatBytes(file.size)),
        dates,
        checksum,
        actions,
      );
      fileTable.append(row);
    }
    document.getElementById('filePage').textContent =
      `${response.total ? offset + 1 : 0}–${offset + response.files.length} of ${response.total}`;
    document.getElementById('previousFiles').disabled = offset === 0;
    document.getElementById('nextFiles').disabled =
      offset + response.files.length >= response.total;
  };
  const updateCleanupFields = () => {
    const age = cleanupMode.value === 'older';
    const range = cleanupMode.value === 'range';
    document.getElementById('cleanupAgeField').hidden = !age;
    document.getElementById('cleanupAge').disabled = !age;
    for (const id of ['cleanupFrom', 'cleanupTo']) {
      document.getElementById(`${id}Field`).hidden = !range;
      document.getElementById(id).disabled = !range;
    }
    clearPreview();
  };
  cleanupMode.addEventListener('change', updateCleanupFields);
  cleanupForm.addEventListener('input', clearPreview);
  cleanupForm.addEventListener('change', clearPreview);
  updateCleanupFields();
  cleanupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearPreview();
    const submit = cleanupForm.querySelector('button');
    submit.disabled = true;
    try {
      const filter = {};
      if (cleanupOwner.value) filter.ownerId = Number(cleanupOwner.value);
      if (cleanupMode.value === 'older') {
        filter.olderThanDays = Number(
          document.getElementById('cleanupAge').value,
        );
      } else if (cleanupMode.value === 'range') {
        for (const [key, id] of [
          ['from', 'cleanupFrom'],
          ['to', 'cleanupTo'],
        ]) {
          const value = document.getElementById(id).value;
          if (value) filter[key] = new Date(value).toISOString();
        }
        if (!filter.from && !filter.to)
          throw new Error('Choose at least one time boundary.');
        if (filter.from && filter.to && filter.from >= filter.to)
          throw new Error('Until must be after From.');
      }
      const version = previewVersion;
      const ownerName = cleanupOwner.selectedOptions[0].textContent;
      const scope =
        cleanupMode.value === 'all'
          ? 'any upload date'
          : cleanupMode.value === 'older'
            ? `older than ${filter.olderThanDays} days`
            : `from ${filter.from ? displayDate(filter.from) : 'the beginning'} until ${filter.to ? displayDate(filter.to) : 'now and future uploads'}`;
      const result = await api('/api/files/preview', {
        method: 'POST',
        body: JSON.stringify(filter),
      });
      if (version !== previewVersion) return;
      preview = result;
      document.getElementById('cleanupSummary').textContent =
        `${result.count} files (${formatBytes(result.logicalBytes)}) from ${ownerName}, ${scope}. Preview expires ${displayDate(result.expiresAt)}.`;
      const list = document.getElementById('cleanupFiles');
      list.replaceChildren();
      for (const file of result.files) {
        const row = document.createElement('tr');
        const name = cell(file.name);
        name.className = 'admin-file-name';
        name.title = file.name;
        row.append(
          name,
          cell(file.owner),
          cell(displayDate(file.createdAt)),
          cell(formatBytes(file.size)),
        );
        list.append(row);
      }
      document.getElementById('cleanupSampleNote').textContent =
        result.files.length < result.count
          ? `Showing ${result.files.length} of ${result.count} matching files. Confirmation deletes all ${result.count} previewed matches.`
          : 'These are the files selected for permanent deletion.';
      const confirmButton = document.getElementById('confirmCleanup');
      confirmButton.disabled = result.count === 0;
      confirmButton.textContent = `[ delete ${result.count} files permanently ]`;
      document.getElementById('cleanupPreview').hidden = false;
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  document
    .getElementById('cancelCleanup')
    .addEventListener('click', clearPreview);
  document
    .getElementById('confirmCleanup')
    .addEventListener('click', async (event) => {
      if (!preview || !preview.count) return;
      if (
        !confirm(
          `Permanently delete the ${preview.count} files in this preview? This cannot be undone.`,
        )
      )
        return;
      event.target.disabled = true;
      try {
        const result = await api('/api/files/delete', {
          method: 'POST',
          body: JSON.stringify({ previewId: preview.previewId }),
        });
        clearPreview();
        offset = 0;
        showStatus(
          `Deleted ${result.deleted} files.${result.skipped ? ` ${result.skipped} were skipped because they changed or are no longer available.` : ''}${result.failed ? ` ${result.failed} could not be deleted; preview again to retry.` : ''}`,
          Boolean(result.failed),
        );
        await load();
      } catch (err) {
        clearPreview();
        showStatus(err.message, true);
      } finally {
        event.target.disabled = false;
      }
    });
  document
    .getElementById('createAccount')
    .addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = event.target.querySelector('button');
      submit.disabled = true;
      try {
        const expiry = document.getElementById('userExpiry').value;
        const token = document.getElementById('customToken').value.trim();
        const result = await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            user: document.getElementById('newUser').value.trim(),
            public: document.getElementById('newPublic').checked,
            ...(token ? { token } : {}),
            expiresAt: expiry ? new Date(expiry).toISOString() : null,
          }),
        });
        revealToken(result.token);
        showStatus(`Created ${result.user}. Save their token now.`);
        event.target.reset();
        await load();
      } catch (err) {
        showStatus(err.message, true);
      } finally {
        submit.disabled = false;
      }
    });
  document
    .getElementById('adminRefresh')
    .addEventListener('click', () =>
      load().catch((err) => showStatus(err.message, true)),
    );
  document.getElementById('adminLogout').addEventListener('click', async () => {
    try {
      await api('/session', { method: 'DELETE' });
      location.replace('/adminpane/login');
    } catch (err) {
      showStatus(err.message, true);
    }
  });
  document.getElementById('copyToken').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(
        document.getElementById('newToken').value,
      );
      showStatus('Token copied.');
    } catch {
      showStatus('Select the token and copy it manually.');
    }
  });
  document.getElementById('dismissToken').addEventListener('click', () => {
    document.getElementById('newToken').value = '';
    document.getElementById('issuedToken').hidden = true;
  });
  document.getElementById('previousFiles').addEventListener('click', () => {
    offset = Math.max(0, offset - 100);
    load().catch((err) => showStatus(err.message, true));
  });
  document.getElementById('nextFiles').addEventListener('click', () => {
    offset += 100;
    load().catch((err) => showStatus(err.message, true));
  });
  load().catch((err) => showStatus(err.message, true));
});
