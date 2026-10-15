import './compat.js';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  version as engineVersion,
} from 'pdfjs-dist/build/pdf.mjs';
import {
  annotationStore,
  attachAnnotations,
  validateAnnotations,
} from './annotations.js';

const assets = new URL('./', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL(
  `pdf.worker.min.mjs?v=${engineVersion}`,
  assets,
).href;

export const setupPDF = async (root, file) => {
  const find = (name) => root.querySelector(`[data-pdf="${name}"]`);
  const status = find('status');
  const canvas = find('canvas');
  const sheet = find('sheet');
  const overlay = find('overlay');
  const text = find('text');
  const scroll = find('scroll');
  const pageInput = find('page');
  const tool = find('tool');
  root.querySelector('#pdfDirect').href = file.previewUrl;
  const loading = getDocument({
    url: file.previewUrl,
    cMapUrl: new URL('cmaps/', assets).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    // Fetch requested ranges only. Document JavaScript/XFA is never executed.
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    isEvalSupported: false,
    maxImageSize: 32000000,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
  });
  let unlock;
  loading.onPassword = (update, reason) => {
    unlock = update;
    find('passwordPanel').hidden = false;
    status.textContent =
      reason === 2 ? 'Incorrect password.' : 'This PDF needs a password.';
    find('password').focus();
  };
  find('unlock').addEventListener('click', () => {
    if (!unlock) return;
    unlock(find('password').value);
    find('password').value = '';
    find('passwordPanel').hidden = true;
  });
  find('password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      find('unlock').click();
    }
  });
  let document;
  try {
    document = await loading.promise;
  } catch {
    status.textContent =
      'Unable to open this PDF. View the original using the link below.';
    return;
  }
  find('count').textContent = String(document.numPages);
  pageInput.max = String(document.numPages);
  let current = 1,
    zoom = 'fit',
    baseViewport,
    renderTask,
    textTask,
    lastPage;
  let renderVersion = 0,
    renderQueue = Promise.resolve(),
    exporting = false;
  const storageKey = `miku:pdf:${file.sha256 || file.url}`;
  let initial = [];
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && saved.length <= 1024 * 1024)
      initial = validateAnnotations(JSON.parse(saved), document.numPages);
  } catch {
    /* Storage may be unavailable; annotations still work in memory. */
  }
  const store = annotationStore(initial);
  const updateHistory = () => {
    find('undo').disabled = !store.canUndo;
    find('redo').disabled = !store.canRedo;
    find('export').disabled = !store.marks.length || exporting;
  };
  const onChange = (message) => {
    updateHistory();
    status.textContent = message || '';
    try {
      const saved = JSON.stringify(store.marks);
      if (saved.length > 1024 * 1024)
        throw new Error('Annotation storage limit');
      localStorage.setItem(storageKey, saved);
    } catch {
      status.textContent =
        'Annotations are in memory. Save a copy to keep them.';
    }
  };
  const annotations = attachAnnotations({
    svg: overlay,
    page: () => current,
    viewport: () => baseViewport,
    tool,
    color: find('color'),
    width: find('width'),
    store,
    onChange,
  });
  const render = () => {
    const ticket = ++renderVersion;
    renderTask?.cancel();
    textTask?.cancel();
    annotations.cancel();
    root.dataset.loading = 'true';
    renderQueue = renderQueue
      .catch(() => undefined)
      .then(async () => {
        if (ticket !== renderVersion) return;
        status.textContent = 'Rendering…';
        const page = await document.getPage(current);
        if (ticket !== renderVersion) return;
        if (lastPage && lastPage !== page) lastPage.cleanup();
        lastPage = page;
        baseViewport = page.getViewport({ scale: 1 });
        const scale =
          zoom === 'fit'
            ? Math.min(
                4,
                Math.max(0.1, (scroll.clientWidth - 18) / baseViewport.width),
              )
            : zoom;
        const viewport = page.getViewport({ scale });
        // A bounded backing canvas keeps zoom/fullscreen memory predictable.
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(8000000 / (viewport.width * viewport.height)),
          16000 / viewport.width,
          16000 / viewport.height,
        );
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        sheet.style.width = `${viewport.width}px`;
        sheet.style.height = `${viewport.height}px`;
        sheet.style.setProperty('--scale-factor', String(scale));
        sheet.style.setProperty('--user-unit', String(page.userUnit || 1));
        overlay.setAttribute(
          'viewBox',
          `0 0 ${baseViewport.width} ${baseViewport.height}`,
        );
        text.replaceChildren();
        sheet.hidden = false;
        pageInput.value = String(current);
        find('zoom').textContent = `${Math.round(scale * 100)}%`;
        find('previous').disabled = current <= 1;
        find('next').disabled = current >= document.numPages;
        updateHistory();
        renderTask = page.render({
          canvas,
          canvasContext: canvas.getContext('2d'),
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
        });
        try {
          await renderTask.promise;
          if (ticket !== renderVersion) return;
          textTask = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: text,
            viewport,
          });
          await textTask.render();
          if (ticket !== renderVersion) return;
          annotations.redraw();
          root.dataset.loading = 'false';
          status.textContent = '';
        } catch (error) {
          if (
            ticket !== renderVersion ||
            ['RenderingCancelledException', 'AbortException'].includes(
              error.name,
            )
          )
            return;
          root.dataset.loading = 'false';
          status.textContent =
            'This page could not be rendered. Try another page or view the original.';
        }
      })
      .catch((error) => {
        if (ticket === renderVersion) {
          root.dataset.loading = 'false';
          status.textContent = 'Unable to render this page.';
          status.title = error.message;
        }
      });
    return renderQueue;
  };
  const navigate = (number) => {
    if (!Number.isFinite(number)) return;
    current = Math.max(1, Math.min(document.numPages, Math.round(number)));
    scroll.scrollTop = 0;
    scroll.scrollLeft = 0;
    void render();
  };
  find('previous').addEventListener('click', () => navigate(current - 1));
  find('next').addEventListener('click', () => navigate(current + 1));
  pageInput.addEventListener('change', () => navigate(Number(pageInput.value)));
  const changeZoom = (amount) => {
    const actual =
      zoom === 'fit' ? (scroll.clientWidth - 18) / baseViewport.width : zoom;
    zoom = Math.max(0.25, Math.min(4, actual + amount));
    void render();
  };
  find('zoomIn').addEventListener('click', () => changeZoom(0.25));
  find('zoomOut').addEventListener('click', () => changeZoom(-0.25));
  find('fit').addEventListener('click', () => {
    zoom = 'fit';
    void render();
  });
  tool.addEventListener('change', () => {
    annotations.cancel();
    root.dataset.tool = tool.value;
  });
  find('undo').addEventListener('click', () => {
    annotations.cancel();
    store.undo();
    annotations.redraw();
    onChange();
  });
  find('redo').addEventListener('click', () => {
    annotations.cancel();
    store.redo();
    annotations.redraw();
    onChange();
  });
  root.addEventListener('keydown', (event) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      find(event.shiftKey ? 'redo' : 'undo').click();
    }
  });
  find('export').addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    updateHistory();
    status.textContent = 'Saving annotated PDF…';
    const snapshot = [...store.marks];
    try {
      // PDF writing is a separate lazy bundle, fetched only when exporting.
      const exportURL = new URL('export.min.js', import.meta.url);
      exportURL.search = new URL(import.meta.url).search;
      const { exportPDF } = await import(exportURL.href);
      await exportPDF(() => document.getData(), document, snapshot, file.name);
      status.textContent = 'Annotated copy saved.';
    } catch {
      status.textContent =
        'Could not save this PDF. Encrypted PDFs may need to be unlocked first.';
    } finally {
      exporting = false;
      updateHistory();
    }
  });
  const fullscreen = find('fullscreen');
  let previousOverflow = '';
  const syncFullscreen = () => {
    const expanded =
      window.document.fullscreenElement === root ||
      root.classList.contains('pdf-expanded');
    fullscreen.textContent = expanded ? '[ exit full ]' : '[ full ]';
    fullscreen.setAttribute('aria-pressed', String(expanded));
  };
  const closeExpanded = () => {
    if (!root.classList.contains('pdf-expanded')) return;
    root.classList.remove('pdf-expanded');
    window.document.body.style.overflow = previousOverflow;
    syncFullscreen();
  };
  fullscreen.addEventListener('click', async () => {
    if (window.document.fullscreenElement === root) {
      await window.document.exitFullscreen();
      return;
    }
    if (root.classList.contains('pdf-expanded')) {
      closeExpanded();
      return;
    }
    try {
      await root.requestFullscreen();
    } catch {
      previousOverflow = window.document.body.style.overflow;
      window.document.body.style.overflow = 'hidden';
      root.classList.add('pdf-expanded');
      syncFullscreen();
    }
  });
  window.document.addEventListener('fullscreenchange', syncFullscreen);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeExpanded();
  });
  let lastWidth = scroll.clientWidth,
    resizeTimer;
  const observer = new ResizeObserver(() => {
    const next = scroll.clientWidth;
    if (next === lastWidth) return;
    lastWidth = next;
    clearTimeout(resizeTimer);
    if (zoom === 'fit')
      resizeTimer = setTimeout(() => {
        void render();
      }, 100);
  });
  observer.observe(scroll);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    observer.disconnect();
    clearTimeout(resizeTimer);
    closeExpanded();
    renderTask?.cancel();
    textTask?.cancel();
    window.document.removeEventListener('fullscreenchange', syncFullscreen);
    void loading.destroy();
  });
  for (const name of [
    'page',
    'zoomIn',
    'zoomOut',
    'fit',
    'tool',
    'color',
    'width',
  ])
    find(name).disabled = false;
  root.dataset.tool = 'select';
  await render();
};
