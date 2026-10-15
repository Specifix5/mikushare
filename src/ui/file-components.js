// Shared DOM components: never interpret uploaded names or tags as markup.
export const metadataPanel = (element, rows) => {
  const fragment = document.createDocumentFragment();
  for (const { label, value } of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    fragment.append(term, detail);
  }
  element.replaceChildren(fragment);
};

// One sharing control for file pages, collections, text, and upload results.
export const shareControls = (actions, link, qr, options = {}) => {
  const button = options.button || document.createElement('button');
  button.type = 'button';
  button.className = 'link-button';
  button.textContent = '[ link ]';
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Copy link and show link / QR code';
  if (!options.button) actions.append(button);
  const panel = options.linkPanel || link;
  const feedback = options.status || document.createElement('p');
  feedback.className = 'file-status share-feedback';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  let url = '',
    name = '',
    image,
    version = 0;
  const collapse = () => {
    panel.hidden = true;
    qr.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const showQR = () => {
    if (image) return;
    const current = version;
    const next = document.createElement('img');
    image = next;
    next.alt = 'QR code for ' + name;
    next.onerror = () => {
      if (current !== version || image !== next) return;
      next.remove();
      image = null;
      feedback.textContent += ' QR unavailable. Click [ link ] again to retry.';
    };
    next.src = '/qrcode?text=' + encodeURIComponent(url) + '&v=2';
    qr.prepend(next);
  };
  button.addEventListener('click', async () => {
    if (!url) return;
    const current = version;
    const visible = panel.hidden;
    panel.hidden = !visible;
    qr.hidden = !visible;
    button.setAttribute('aria-expanded', String(visible));
    if (visible) showQR();
    try {
      await navigator.clipboard.writeText(url);
      if (current === version) feedback.textContent = 'Link copied.';
    } catch {
      if (current !== version) return;
      panel.hidden = false;
      qr.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      showQR();
      if (link.tagName === 'INPUT') {
        link.focus();
        link.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(link);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      feedback.textContent = 'Select and copy the link above.';
    }
  });
  if (!options.status) qr.append(feedback);
  collapse();
  return {
    update(nextURL, nextName) {
      if (url !== nextURL) {
        version++;
        image?.remove();
        image = null;
        feedback.textContent = '';
        collapse();
      }
      url = nextURL;
      name = nextName;
      if (link.tagName === 'INPUT') link.value = url;
      else link.textContent = url;
      link.classList.add('share-link');
      button.disabled = !url;
      if (image) image.alt = 'QR code for ' + name;
    },
    dispose() {
      version++;
      image?.remove();
      image = null;
      feedback.textContent = '';
      collapse();
    },
  };
};

export const fileActions = (root, file) => {
  const find = (selector) => root.querySelector(selector);
  find('[data-download]').href = file.downloadUrl;
  const controls = shareControls(
    find('[data-file-actions]'),
    find('[data-share-link]'),
    find('[data-qr-panel]'),
    {
      button: find('[data-link-toggle]'),
    },
  );
  controls.update(file.url, file.name);
};
