document.addEventListener('DOMContentLoaded', async () => {
  const title = document.getElementById('textTitle');
  if (!title) return;
  const status = document.getElementById('textStatus');
  const copyText = document.getElementById('copyText');
  const copyLink = document.getElementById('copyTextLink');
  const qrButton = document.getElementById('textQRButton');
  const qr = document.getElementById('textQR');
  const key = location.pathname.split('/')[2];
  let paste;
  let qrVisible = false;
  let qrVersion = 0;
  let qrSVG;
  const body = document.getElementById('textBody');
  const gutter = document.getElementById('textLines');
  const content = body.parentElement;
  let gutterWidth = -1;
  const alignGutter = () => {
    if (!paste || content.clientWidth === gutterWidth) return;
    gutterWidth = content.clientWidth;
    const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
    const source = body.firstChild;
    const range = document.createRange();
    const numbers = [];
    const lines = paste.content.split(/\r\n|\r|\n/);
    const endings = paste.content.match(/\r\n|\r|\n/g) || [];
    let offset = 0;
    let firstTop;
    lines.forEach((line, index) => {
      if (source && source.length) {
        const trailingLine = offset === source.length;
        range.setStart(source, trailingLine ? offset - 1 : offset);
        range.setEnd(source, trailingLine ? offset : offset + 1);
        const rect = range.getClientRects()[0];
        if (rect) {
          firstTop ??= rect.top;
          const row =
            Math.round((rect.top - firstTop) / lineHeight) +
            Number(trailingLine);
          while (numbers.length < row) numbers.push('');
        }
      }
      numbers.push(String(index + 1));
      offset += line.length + (endings[index]?.length || 0);
    });
    gutter.textContent = numbers.join('\n');
  };
  new ResizeObserver(alignGutter).observe(content);
  document.fonts.ready.then(() => {
    gutterWidth = -1;
    alignGutter();
  });
  const copy = async (button, value, label) => {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = '[ copied ]';
    } catch {
      if (button === copyLink && status.hidden) {
        button.textContent = '[ copy failed ]';
      } else {
        const range = document.createRange();
        range.selectNodeContents(button === copyText ? body : status);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = '[ select and copy ]';
      }
    } finally {
      button.disabled = false;
      setTimeout(() => {
        button.textContent = label;
      }, 1500);
    }
  };
  copyText.addEventListener('click', () =>
    copy(copyText, paste.content, '[ copy text ]'),
  );
  copyLink.addEventListener('click', () =>
    copy(copyLink, paste.url, '[ copy link ]'),
  );
  const renderQR = () => {
    status.hidden = !qrVisible;
    qr.hidden = !qrVisible;
    qr.replaceChildren();
    if (!qrVisible || !qrSVG) return;
    const image = document.createElement('img');
    image.alt = `QR code for ${paste.title}`;
    image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(qrSVG);
    qr.append(image);
  };
  qrButton.addEventListener('click', async () => {
    qrVisible = !qrVisible;
    qrButton.textContent = qrVisible ? '[ hide qr ]' : '[ show qr ]';
    qrButton.setAttribute('aria-pressed', String(qrVisible));
    const version = ++qrVersion;
    renderQR();
    if (!qrVisible || qrSVG) return;
    try {
      const response = await fetch(
        `/qrcode?text=${encodeURIComponent(paste.url)}&v=2`,
      );
      if (!response.ok) throw new Error('QR unavailable');
      const svg = await response.text();
      if (version !== qrVersion) return;
      qrSVG = svg;
      renderQR();
    } catch {
      if (version !== qrVersion) return;
      qrVisible = false;
      qrButton.setAttribute('aria-pressed', 'false');
      renderQR();
      qrButton.textContent = '[ retry qr ]';
    }
  });
  try {
    const response = await fetch(`/texts/${encodeURIComponent(key)}/info`, {
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error('This text is unavailable (expired or deleted).');
    paste = await response.json();
    title.textContent = paste.title;
    document.title = paste.title;
    body.textContent = paste.content;
    // Leave the source untouched and pad the separate gutter for wrapped rows.
    document.getElementById('textView').hidden = false;
    alignGutter();
    document.getElementById('textInfo').textContent =
      `Uploaded: ${new Date(paste.createdAt).toLocaleString()} · Expires: ${paste.expiresAt ? new Date(paste.expiresAt).toLocaleString() : 'Never'} · ${paste.size.toLocaleString()} UTF-8 bytes`;
    const raw = document.getElementById('rawText');
    raw.href = paste.rawUrl;
    raw.hidden = false;
    status.textContent = paste.url;
    status.hidden = true;
    document.getElementById('textHash').textContent = paste.sha256;
    document.getElementById('textChecksum').hidden = !paste.sha256;
    [copyText, copyLink, qrButton].forEach((button) => {
      button.disabled = false;
    });
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  }
});
