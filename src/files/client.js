import { fileActions, metadataPanel } from '../ui/file-components.js';

document.addEventListener('DOMContentLoaded', async () => {
  const data = document.getElementById('fileData');
  if (!data) return;
  const file = JSON.parse(data.textContent);
  const get = (id) => document.getElementById(id);
  const formatSize = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(
      3,
      Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)),
    );
    return `${(bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[index]}`;
  };
  fileActions(get('filePage'), file);
  get('fileSummary').textContent = `${formatSize(file.size)} / ${file.mime}`;
  const rows = [
    { label: 'File name', value: file.name },
    {
      label: 'Size',
      value: `${formatSize(file.size)} (${file.size.toLocaleString()} bytes)`,
    },
    { label: 'Type', value: file.mime },
    { label: 'Uploaded', value: new Date(file.createdAt).toLocaleString() },
    {
      label: 'Expires',
      value: file.expiresAt
        ? new Date(file.expiresAt).toLocaleString()
        : 'Never',
    },
    ...(file.sha256 ? [{ label: 'SHA-256', value: file.sha256 }] : []),
  ];
  const addDetail = (label, value) => {
    const row = rows.find((row) => row.label === label);
    if (row) row.value = value;
    else rows.push({ label, value });
    metadataPanel(get('fileDetails'), rows);
  };
  metadataPanel(get('fileDetails'), rows);
  const preview = get(`${file.kind}Preview`);
  if (preview) preview.hidden = false;
  if (file.kind === 'image') {
    const image = get('previewImage');
    image.alt = file.name;
    image.onload = () =>
      addDetail(
        'Dimensions',
        `${image.naturalWidth} × ${image.naturalHeight} pixels`,
      );
    image.onerror = () => {
      get('imageError').textContent =
        'This image cannot be previewed by your browser. Download the original above.';
    };
    image.src = file.previewUrl;
  }
  if (file.kind === 'pdf') {
    get('pdfDirect').href = file.previewUrl;
    const assets = '/public/pdf/';
    const version = '{%assetVersion%}';
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${assets}viewer.min.css?v=${version}`;
    document.head.append(stylesheet);
    try {
      const moduleURL = `${assets}viewer.min.js?v=${version}`;
      const { setupPDF } = await import(moduleURL);
      await setupPDF(get('pdfPreview'), file);
    } catch {
      get('pdfPreview').querySelector('[data-pdf="status"]').textContent =
        'PDF viewer unavailable. View the original using the link below.';
    }
  }
  if (file.kind === 'video') get('videoPlayer').src = file.previewUrl;
  if (file.kind === 'audio') {
    get('trackTitle').textContent = file.name;
    setupAudio(file, get);
  }
  if (!['audio', 'image', 'video'].includes(file.kind)) return;
  get('mediaDetailsStatus').textContent = 'Loading...';
  try {
    const response = await fetch(file.infoUrl, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(
        'Metadata is unavailable. This file may have expired or been deleted.',
      );
    const info = await response.json();
    metadataPanel(get('mediaDetails'), info.metadata);
    get('mediaDetailsStatus').textContent = info.metadata.length
      ? ''
      : info.metadataNote
        ? 'Unavailable'
        : 'None';
    get('mediaDetailsStatus').title = info.metadataNote || '';
    if (info.title) get('trackTitle').textContent = info.title;
    if (info.artist) get('trackArtist').textContent = info.artist;
    if (info.coverUrl) {
      const cover = get('albumCover');
      cover.onerror = () => {
        cover.hidden = true;
      };
      cover.src = info.coverUrl;
      cover.hidden = false;
    }
  } catch (error) {
    get('mediaDetailsStatus').textContent = 'Unavailable';
    get('mediaDetailsStatus').title = error.message;
  }
});

const setupAudio = (file, get) => {
  const audio = get('audioPlayer');
  const speed = get('playbackSpeed');
  const updateSpeed = () => {
    audio.playbackRate = Number(speed.value);
    get('speedValue').value = `${Number(speed.value).toFixed(2)}×`;
  };
  speed.addEventListener('input', updateSpeed);
  get('resetSpeed').addEventListener('click', () => {
    speed.value = '1';
    updateSpeed();
  });
  get('preservePitch').addEventListener('change', (event) => {
    audio.preservesPitch = event.target.checked;
  });
  audio.addEventListener('error', () => {
    get('audioError').textContent =
      'Your browser cannot play this audio. Download the original above.';
  });
  const canvas = get('audioWaveform');
  const context = canvas.getContext('2d');
  const status = get('waveformStatus');
  let peaks;
  const draw = () => {
    if (!peaks || !context) return;
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    context.clearRect(0, 0, canvas.width, canvas.height);
    peaks.forEach((peak, index) => {
      context.fillStyle =
        index / peaks.length <= progress ? '#7ad4e4' : '#585b70';
      const height = Math.max(2, peak * (canvas.height - 12));
      context.fillRect(
        (index * canvas.width) / peaks.length,
        (canvas.height - height) / 2,
        Math.max(1, canvas.width / peaks.length - 1),
        height,
      );
    });
    canvas.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    canvas.setAttribute(
      'aria-valuetext',
      `${Math.round(audio.currentTime)} of ${Math.round(audio.duration)} seconds`,
    );
  };
  audio.addEventListener('timeupdate', draw);
  audio.addEventListener('seeked', draw);
  canvas.addEventListener('click', (event) => {
    if (!Number.isFinite(audio.duration)) return;
    const box = canvas.getBoundingClientRect();
    audio.currentTime =
      Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) *
      audio.duration;
  });
  canvas.addEventListener('keydown', (event) => {
    if (!Number.isFinite(audio.duration)) return;
    const delta = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[
      event.key
    ];
    if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    audio.currentTime =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? audio.duration
          : Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
  });
  audio.addEventListener(
    'loadedmetadata',
    async () => {
      updateSpeed();
      // Decode a bounded, downsampled copy; playback always streams independently.
      const Decoder =
        window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (
        !context ||
        !Decoder ||
        file.size > 32 * 1024 * 1024 ||
        !Number.isFinite(audio.duration) ||
        audio.duration > 600
      ) {
        status.textContent =
          'Waveform unavailable for this file. Use the player timeline to seek.';
        return;
      }
      status.textContent = 'Building waveform...';
      try {
        const response = await fetch(file.previewUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('Audio unavailable');
        const decoder = new Decoder(1, 1, 8000);
        const decoded = await decoder.decodeAudioData(
          await response.arrayBuffer(),
        );
        const bins = Math.min(800, decoded.length);
        peaks = new Float32Array(bins);
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const samples = decoded.getChannelData(channel);
          for (let index = 0; index < samples.length; index++) {
            const bin = Math.min(
              bins - 1,
              Math.floor((index * bins) / samples.length),
            );
            peaks[bin] = Math.max(peaks[bin], Math.abs(samples[index]));
          }
        }
        canvas.hidden = false;
        draw();
        status.textContent = '';
      } catch {
        status.textContent =
          'Waveform unavailable for this format. Playback controls still work.';
      }
    },
    { once: true },
  );
  audio.src = file.previewUrl;
};
