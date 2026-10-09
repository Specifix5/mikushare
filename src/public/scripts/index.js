import { normalizeFilename, uniqueFilenames } from '@miku/filenames';
import { canConvertToWebP, convertToWebP, webpFilename } from './webp';

const maxSize = Number('{%maxSize%}');
const maxTempSize = Number('{%maxTempSize%}');
const maxBatchSize = Number('{%maxBatchSize%}');
const maxFiles = Number('{%maxFiles%}');
const maxTextSize = Number('{%maxTextSize%}');

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('uploadForm');
  if (!form) return;
  const uploader = document.getElementById('uploader');
  const picker = document.getElementById('file');
  const key = document.getElementById('key');
  const selection = document.getElementById('selectedFiles');
  const summary = document.getElementById('fileName');
  const submit = document.getElementById('uploadButton');
  const temp = document.getElementById('temporaryCheck');
  const duration = document.getElementById('durationSelect');
  const collectionCheck = document.getElementById('collectionCheck');
  const collectionName = document.getElementById('collectionName');
  const collectionResult = document.getElementById('collectionResult');
  const output = document.getElementById('output');
  const feedback = document.getElementById('uploadFeedback');
  const results = document.getElementById('uploadResults');
  const textMode = document.getElementById('textMode');
  const fileMode = document.getElementById('fileMode');
  const pasteContent = document.getElementById('pasteContent');
  const pasteTitle = document.getElementById('pasteTitle');
  const textSummary = document.getElementById('textSummary');
  const textProgress = document.getElementById('textProgress');
  let mode = 'file';
  let selected = [];
  let uploading = false;
  const message = (text) => {
    feedback.hidden = false;
    output.textContent = text;
    output.classList.remove('hide');
  };
  const status = (row, text) => {
    row.querySelector('.file-status').textContent = text;
  };
  const button = (label, action) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = `[ ${label.toLowerCase()} ]`;
    element.className = 'link-button';
    element.setAttribute('aria-label', label);
    element.addEventListener('click', async () => {
      element.disabled = true;
      try {
        await action();
      } finally {
        element.disabled = false;
      }
    });
    return element;
  };
  const row = (name, size) => {
    const element = document.createElement('div');
    element.className = 'file-row';
    element.setAttribute('role', 'row');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.maxLength = 150;
    input.setAttribute('aria-label', 'Filename');
    input.className = 'file-name';
    const bytes = document.createElement('span');
    bytes.className = 'file-size';
    bytes.textContent =
      size < 1024
        ? `${size} B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${(size / 1024 / 1024).toFixed(1)} MB`;
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const log = document.createElement('p');
    log.className = 'file-status';
    log.setAttribute('role', 'status');
    const qr = document.createElement('div');
    qr.className = 'file-qr';
    element.append(input, bytes, actions, log, qr);
    return element;
  };
  const validate = () => {
    const limit = temp.checked ? maxTempSize : maxSize;
    if (mode === 'text') {
      const bytes = new TextEncoder().encode(pasteContent.value).length;
      const cap = Math.min(maxTextSize, limit, maxBatchSize);
      const problem =
        bytes > cap * 1024 * 1024 ? `Text must be at most ${cap} MB.` : '';
      textSummary.textContent =
        problem || `${bytes.toLocaleString()} UTF-8 bytes · Max ${cap} MB`;
      textSummary.classList.toggle('error', !!problem);
      submit.disabled =
        uploading ||
        !!problem ||
        !pasteContent.value.length ||
        !key.value.trim() ||
        (temp.checked && !duration.value);
      return !problem;
    }
    let problem = '';
    if (selected.some((entry) => entry.converting))
      problem = 'Converting images...';
    else if (selected.some((entry) => entry.conversionError))
      problem = 'Fix the image conversion error or uncheck Save as WebP.';
    else if (selected.length > maxFiles)
      problem = `Choose at most ${maxFiles} files.`;
    else if (selected.some((entry) => entry.file.size > limit * 1024 * 1024))
      problem = `Max per file is ${limit} MB.`;
    else if (
      selected.reduce((sum, entry) => sum + entry.file.size, 0) >
      maxBatchSize * 1024 * 1024
    )
      problem = `Max total is ${maxBatchSize} MB.`;
    summary.textContent =
      problem ||
      (selected.length
        ? `${selected.length} file${selected.length === 1 ? '' : 's'} selected`
        : '');
    summary.classList.toggle('error', !!problem);
    selected.forEach((entry) => {
      const oversized = entry.file.size > limit * 1024 * 1024;
      entry.row.classList.toggle('error', oversized);
      if (oversized) status(entry.row, `Max per file is ${limit} MB.`);
      else if (
        entry.row
          .querySelector('.file-status')
          .textContent.startsWith('Max per file')
      )
        status(entry.row, '');
    });
    submit.disabled =
      uploading ||
      !!problem ||
      !selected.length ||
      !key.value.trim() ||
      (temp.checked && !duration.value);
    uploader.setAttribute('aria-disabled', String(uploading));
    return !problem;
  };
  const renderSelection = () => {
    selection.replaceChildren();
    selected.forEach((entry) => {
      const element = row(entry.name, entry.file.size);
      entry.row = element;
      const input = element.querySelector('.file-name');
      input.addEventListener('change', () => {
        entry.name = normalizeFilename(input.value);
        if (entry.webp && !entry.conversionError)
          entry.name = webpFilename(entry.name);
        input.value = entry.name;
        status(element, 'Name updated.');
      });
      const remove = button('x', () => {
        if (uploading) return;
        selected = selected.filter((item) => item !== entry);
        renderSelection();
        validate();
      });
      remove.classList.add('remove-file');
      remove.setAttribute('aria-label', `Remove ${entry.name}`);
      remove.title = 'Remove file';
      element.querySelector('.file-actions').append(remove);
      if (canConvertToWebP(entry.original)) {
        const options = document.createElement('div');
        options.className = 'image-options';
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!entry.webp;
        label.append(check, ' Save as WebP');
        const qualityLabel = document.createElement('label');
        qualityLabel.append('Quality ');
        const quality = document.createElement('input');
        quality.type = 'number';
        quality.min = '1';
        quality.max = '100';
        quality.step = '1';
        quality.value = String(entry.quality ?? 85);
        quality.disabled = !check.checked;
        quality.setAttribute('aria-label', 'WebP quality percentage');
        qualityLabel.append(quality, ' %');
        options.append(label, qualityLabel);
        element.insertBefore(options, element.querySelector('.file-status'));
        const update = async () => {
          const version = (entry.conversionVersion =
            (entry.conversionVersion ?? 0) + 1);
          entry.webp = check.checked;
          entry.quality = Number(quality.value);
          quality.disabled = !check.checked;
          entry.conversionError = '';
          entry.converting = check.checked;
          if (!check.checked) {
            entry.file = entry.original;
            entry.name =
              entry.name.replace(/\.[^.]+$/, '') +
              (/\.[^.]+$/.exec(entry.original.name)?.[0] ?? '');
            renderSelection();
            validate();
            return;
          }
          status(element, 'Converting to WebP...');
          validate();
          try {
            const converted = await convertToWebP(
              entry.original,
              entry.quality,
            );
            if (
              version !== entry.conversionVersion ||
              !selected.includes(entry)
            )
              return;
            entry.file = converted;
            entry.name = webpFilename(entry.name);
            if (
              mode === 'file' &&
              !uploading &&
              converted.size > maxSize * 1024 * 1024
            ) {
              temp.checked = true;
              duration.disabled = false;
              if (!duration.value) duration.value = '24h';
            }
          } catch (error) {
            if (
              version !== entry.conversionVersion ||
              !selected.includes(entry)
            )
              return;
            entry.conversionError =
              error.message || 'Could not convert this image.';
          }
          entry.converting = false;
          renderSelection();
          status(
            entry.row,
            entry.conversionError ||
              `WebP at ${entry.quality}% quality. Transparency preserved.`,
          );
          validate();
        };
        check.addEventListener('change', update);
        quality.addEventListener('change', update);
        if (entry.conversionError) status(element, entry.conversionError);
        else if (entry.converting) status(element, 'Converting to WebP...');
      }
      selection.append(element);
    });
  };
  const choose = (files) => {
    if (uploading) return;
    const names = uniqueFilenames(Array.from(files, (file) => file.name));
    selected = Array.from(files, (file, index) => ({
      file,
      original: file,
      name: names[index],
    }));
    if (selected.some((entry) => entry.file.size > maxSize * 1024 * 1024)) {
      temp.checked = true;
      duration.disabled = false;
      if (!duration.value) duration.value = '24h';
    }
    renderSelection();
    validate();
  };
  const setMode = (next) => {
    if (uploading) return;
    mode = next;
    const text = mode === 'text';
    document.getElementById('fileSource').hidden = text;
    document.getElementById('textSource').hidden = !text;
    document.getElementById('collectionOptions').hidden = text;
    document.getElementById('pasteTitleOption').hidden = !text;
    const bytes = text
      ? new TextEncoder().encode(pasteContent.value).length
      : Math.max(0, ...selected.map((entry) => entry.file.size));
    if (bytes > maxSize * 1024 * 1024) {
      temp.checked = true;
      duration.disabled = false;
      if (!duration.value) duration.value = '24h';
    }
    textMode.setAttribute('aria-pressed', String(text));
    fileMode.setAttribute('aria-pressed', String(!text));
    validate();
  };
  textMode.addEventListener('click', () => setMode('text'));
  fileMode.addEventListener('click', () => setMode('file'));
  pasteContent.addEventListener('input', () => {
    if (
      new TextEncoder().encode(pasteContent.value).length >
      maxSize * 1024 * 1024
    ) {
      temp.checked = true;
      duration.disabled = false;
      if (!duration.value) duration.value = '24h';
    }
    validate();
  });
  uploader.addEventListener('click', (event) => {
    if (event.target !== picker && !uploading) picker.click();
  });
  uploader.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!uploading) picker.click();
    }
  });
  const dragOver = (event) => {
    event.preventDefault();
    if (!uploading) uploader.classList.add('dragover');
  };
  uploader.addEventListener('dragenter', dragOver);
  uploader.addEventListener('dragover', dragOver);
  uploader.addEventListener('dragleave', (event) => {
    event.preventDefault();
    uploader.classList.remove('dragover');
  });
  uploader.addEventListener('drop', (event) => {
    event.preventDefault();
    uploader.classList.remove('dragover');
    choose(event.dataTransfer.files);
  });
  picker.addEventListener('change', () => choose(picker.files));
  key.addEventListener('input', validate);
  duration.addEventListener('change', validate);
  temp.addEventListener('change', () => {
    duration.disabled = !temp.checked;
    if (!temp.checked) duration.value = '';
    validate();
  });
  collectionCheck.addEventListener('change', () => {
    collectionName.hidden = !collectionCheck.checked;
  });

  const shareControls = (element, url, name) => {
    const log = element.querySelector('.file-status');
    const holder = element.querySelector('.file-qr');
    const actions = element.querySelector('.file-actions');
    let visible = false;
    let version = 0;
    let svg;
    log.textContent = url;
    log.hidden = true;
    holder.hidden = true;
    const copy = button('copy', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = '[ copied ]';
      } catch {
        copy.textContent = log.hidden ? '[ copy failed ]' : '[ select link ]';
        if (!log.hidden) {
          const range = document.createRange();
          range.selectNodeContents(log);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
      setTimeout(() => {
        copy.textContent = '[ copy ]';
      }, 1500);
    });
    const qrButton = document.createElement('button');
    qrButton.type = 'button';
    qrButton.className = 'link-button';
    qrButton.textContent = '[ show qr ]';
    qrButton.setAttribute('aria-pressed', 'false');
    const render = () => {
      log.hidden = !visible;
      holder.hidden = !visible;
      qrButton.textContent = visible ? '[ hide qr ]' : '[ show qr ]';
      qrButton.setAttribute('aria-pressed', String(visible));
      holder.replaceChildren();
      if (!visible || !svg) return;
      const image = document.createElement('img');
      image.alt = `QR code for ${name}`;
      image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      holder.append(image);
    };
    qrButton.addEventListener('click', async () => {
      visible = !visible;
      const current = ++version;
      render();
      if (!visible || svg) return;
      try {
        const response = await fetch(
          `/qrcode?text=${encodeURIComponent(url)}&v=2`,
        );
        if (!response.ok) throw new Error('QR unavailable');
        const result = await response.text();
        if (current !== version) return;
        svg = result;
        render();
      } catch {
        if (current !== version) return;
        visible = false;
        render();
        qrButton.textContent = '[ retry qr ]';
      }
    });
    actions.append(copy, qrButton);
  };
  const showResults = (files, collection) => {
    results.replaceChildren();
    collectionResult.replaceChildren();
    for (const file of files) {
      const element = row(file.realFilename, 0);
      element.classList.add('upload-result');
      element.querySelector('.file-size').remove();
      const link = document.createElement('a');
      link.href = file.url;
      link.textContent = file.realFilename;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'file-name file-link';
      link.title = file.realFilename;
      element.querySelector('.file-name').replaceWith(link);
      const checksum = document.createElement('details');
      checksum.className = 'file-checksum';
      const checksumLabel = document.createElement('summary');
      checksumLabel.textContent = `SHA-256 ${file.sha256.slice(0, 12)}\u2026`;
      const checksumValue = document.createElement('code');
      checksumValue.textContent = file.sha256;
      checksum.append(checksumLabel, checksumValue);
      shareControls(element, file.url, file.realFilename);
      const metadata = document.createElement('div');
      metadata.className = 'file-meta';
      const log = element.querySelector('.file-status');
      element.insertBefore(metadata, log);
      metadata.append(log, checksum);
      results.append(element);
    }
    if (collection) {
      const element = row(collection.name, 0);
      element.classList.add('collection-result');

      element.querySelector('.file-size').remove();
      const link = document.createElement('a');
      link.href = collection.url;
      link.textContent = collection.name;
      link.className = 'file-name file-link';
      link.title = 'Open collection';
      element.querySelector('.file-name').replaceWith(link);
      link.target = '_blank';
      link.rel = 'noopener';
      shareControls(element, collection.url, collection.name);
      collectionResult.append(element);
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (uploading || !validate() || submit.disabled) return;
    const text = mode === 'text';
    const title = pasteTitle.value.trim() || 'untitled';
    let uploadEntries = selected;
    if (text) {
      const name = normalizeFilename(`${title}.txt`);
      const file = new File([pasteContent.value], name, {
        type: 'text/plain;charset=utf-8',
      });
      const element = row(name, file.size);
      element.querySelector('.file-name').readOnly = true;
      textProgress.replaceChildren(element);
      uploadEntries = [{ file, name, row: element }];
    }
    const names = uniqueFilenames(
      uploadEntries.map((entry) => {
        const name = entry.row.querySelector('.file-name').value;
        return entry.webp ? webpFilename(name) : name;
      }),
    );
    const manifest = {
      files: uploadEntries.map((entry, index) => ({
        name: names[index],
        size: entry.file.size,
      })),
    };
    if (temp.checked)
      manifest.ttl =
        parseInt(duration.value, 10) * (duration.value.endsWith('d') ? 24 : 1);
    if (text) manifest.textTitle = title;
    if (!text && collectionCheck.checked)
      manifest.collectionName = collectionName.value.trim() || 'collection';
    const accessKey = key.value.trim();
    const authorization = { Authorization: `Bearer ${accessKey}` };
    const controller = new AbortController();
    const active = new Set();
    let session;
    uploading = true;
    [
      key,
      temp,
      duration,
      picker,
      collectionCheck,
      collectionName,
      textMode,
      fileMode,
      pasteContent,
      pasteTitle,
    ].forEach((element) => {
      element.disabled = true;
    });
    selection.querySelectorAll('input,button').forEach((element) => {
      element.disabled = true;
    });
    results.replaceChildren();
    collectionResult.replaceChildren();
    validate();
    message('Uploading...');
    const jsonRequest = async (url, options = {}) => {
      const response = await fetch(url, {
        ...options,
        headers: { ...authorization, ...options.headers },
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      return response.json();
    };
    const sendChunk = (job, progress) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        active.add(xhr);
        xhr.open('PUT', `/ui-upload/${session.id}/${job.file}/${job.chunk}`);
        xhr.setRequestHeader('Authorization', authorization.Authorization);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.timeout = 120000;
        xhr.upload.onprogress = (event) => progress(event.loaded);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
        xhr.onerror = () =>
          reject(new Error('Network error. Please try again.'));
        xhr.ontimeout = () => reject(new Error('Chunk upload timed out.'));
        xhr.onabort = () => reject(new Error('Upload cancelled.'));
        xhr.onloadend = () => active.delete(xhr);
        xhr.send(uploadEntries[job.file].file.slice(job.start, job.end));
      });
    try {
      session = await jsonRequest('/ui-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      const jobs = [];
      const loaded = uploadEntries.map(() => new Map());
      uploadEntries.forEach((entry, index) => {
        status(entry.row, 'Uploading... 0%');
        for (
          let start = 0, chunk = 0;
          start < entry.file.size;
          start += session.chunkSize, chunk++
        )
          jobs.push({
            file: index,
            chunk,
            start,
            end: Math.min(start + session.chunkSize, entry.file.size),
          });
      });
      let cursor = 0;
      let stopped = false;
      const reportProgress = (job) => (bytes) => {
        loaded[job.file].set(job.chunk, Math.min(bytes, job.end - job.start));
        const uploaded = [...loaded[job.file].values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        status(
          uploadEntries[job.file].row,
          `Uploading... ${Math.round((uploaded / uploadEntries[job.file].file.size) * 100)}%`,
        );
      };
      const worker = async () => {
        try {
          while (cursor < jobs.length) {
            if (stopped) break;
            const job = jobs[cursor++];
            await sendChunk(job, reportProgress(job));
            loaded[job.file].set(job.chunk, job.end - job.start);
          }
        } catch (error) {
          stopped = true;
          active.forEach((xhr) => xhr.abort());
          throw error;
        }
      };
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(3, session.concurrency) }, worker),
      );
      const failed = workers.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      uploadEntries.forEach((entry) => status(entry.row, 'Saving...'));
      const response = await jsonRequest(`/ui-upload/${session.id}/complete`, {
        method: 'POST',
      });
      showResults(response.files, response.collection);
      message(
        text
          ? 'Text uploaded!'
          : `Uploaded ${uploadEntries.length} file${uploadEntries.length === 1 ? '' : 's'}!`,
      );
      if (text) textProgress.replaceChildren();
      else {
        selected = [];
        picker.value = '';
        selection.replaceChildren();
      }
    } catch (error) {
      controller.abort();
      active.forEach((xhr) => xhr.abort());
      uploadEntries.forEach((entry) => status(entry.row, error.message));
      message('Upload failed. Your selection is kept.');
      if (session) {
        // Wait for aborts to reach the server before discarding staged chunks.
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetch(`/ui-upload/${session.id}`, {
            method: 'DELETE',
            headers: authorization,
          }).catch(() => null);
          if (!response || response.status !== 409) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } finally {
      uploading = false;
      [
        key,
        temp,
        picker,
        collectionCheck,
        collectionName,
        textMode,
        fileMode,
        pasteContent,
        pasteTitle,
      ].forEach((element) => {
        element.disabled = false;
      });
      duration.disabled = !temp.checked;
      selection.querySelectorAll('input,button').forEach((element) => {
        element.disabled = false;
      });
      selected.forEach((entry) => {
        const quality = entry.row.querySelector(
          '.image-options input[type="number"]',
        );
        if (quality) quality.disabled = !entry.webp;
      });
      validate();
    }
  });
  validate();
});
