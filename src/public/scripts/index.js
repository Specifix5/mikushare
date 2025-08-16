const units = { d: 24, h: 1 }; // in hours

const maxSize = isNaN(Number('{%maxSize%}')) ? 65 : Number('{%maxSize%}');
const maxTempSize = isNaN(Number('{%maxTempSize%}'))
  ? 95
  : Number('{%maxTempSize%}');

const parseTime = (str) => {
  return Array.from(str.matchAll(/(\d+)([dh])/g))
    .map(([_, num, unit]) => +num * units[unit])
    .reduce((a, b) => a + b, 0);
};

const getVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

const defaultFileLabelMessage = `Browse... (Max ${maxSize}MB, Temp ${maxTempSize}MB)`;

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('uploadForm');
  const fileInput = document.getElementById('file');
  const keyInput = document.getElementById('key');
  const fileName = document.getElementById('fileName');
  const uploadBtn = document.getElementById('uploadButton');
  const tempCheck = document.getElementById('temporaryCheck');
  const tempCheckLabel = document.getElementById('temporaryLabel');
  const durationSelect = document.getElementById('durationSelect');

  const outputLabel = document.getElementById('output');
  const copyBtn = document.getElementById('copyBtn');

  const copyBtnSvgs = document.querySelectorAll('#copyBtn svg');
  const qrCodeHolder = document.querySelector('#qrcodeHolder');

  // Set initial state
  fileName.textContent = defaultFileLabelMessage;
  uploadBtn.disabled = true;
  durationSelect.disabled = true;
  tempCheck.checked = false;
  tempCheckLabel.classList.add('disabled');
  qrCodeHolder.classList.add('hide');
  qrCodeHolder.innerHTML = '';

  const uploadFile = (key, formData) => {
    uploadBtn.disabled = true;
    outputLabel.classList.remove('hide');
    outputLabel.classList.remove('underline');
    outputLabel.innerHTML = `Uploading...<span class="blue"> [0%]</span>`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload?key=${encodeURIComponent(key)}`);
    xhr.responseType = 'json';

    function handleUploadError(message) {
      console.error(message);
      alert('Upload error: ' + message);

      fileInput.value = '';
      fileName.textContent = '❌ ' + message;
      fileName.classList.add('error');
      outputLabel.innerHTML = '';
      copyBtnSvgs.forEach((svg) => svg.classList.add('hide'));
      outputLabel.classList.add('hide');
      qrCodeHolder.innerHTML = '';
      qrCodeHolder.classList.add('hide');
      uploadBtn.disabled = true;
    }

    // progress bar
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const p = Math.round((e.loaded / e.total) * 100);
        outputLabel.innerHTML = `Uploading...<span class="blue"> [${p}%]</span>`;
      } else {
        outputLabel.innerHTML = 'Uploading...';
      }
    };

    // success
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = xhr.response ?? JSON.parse(xhr.responseText || '{}');
        if (data && data.url) {
          outputLabel.classList.add('underline');
          outputLabel.textContent = data.url ?? '';
          copyBtnSvgs.forEach((svg) => svg.classList.remove('hide'));

          fileInput.value = '';
          fileName.textContent = defaultFileLabelMessage;
          fileName.classList.remove('error');
          return;
        }
        return handleUploadError('No URL in response');
      }
      handleUploadError(`${xhr.status} ${xhr.statusText || 'HTTP error'}`);
    };

    // errors
    xhr.onerror = () => handleUploadError('Network error');
    xhr.onabort = () => handleUploadError('Upload cancelled');
    xhr.ontimeout = () => handleUploadError('Upload timed out');

    xhr.send(formData);
  };

  copyBtn.addEventListener('click', async () => {
    if (
      copyBtn.disabled ||
      copyBtn.classList.contains('hide') ||
      outputLabel.classList.contains('hide') ||
      !outputLabel.classList.contains('underline')
    )
      return;
    try {
      if (document.visibilityState !== 'visible')
        throw new Error('Document not visible');
      await navigator.clipboard.writeText(outputLabel.textContent);
      alert('☑️ Copied to clipboard!\nURL: ' + outputLabel.textContent);
    } catch (err) {
      console.warn('Failed to copy to clipboard: ', err);
      const range = document.createRange();
      range.selectNodeContents(outputLabel);

      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      alert('Press Ctrl + C to copy manually.');
    }

    // Show QR code
    fetch(`/qrcode?text=${encodeURIComponent(outputLabel.textContent)}`)
      .then((r) => {
        if (!r.ok) throw new Error('failed ' + r.status);
        return r.text();
      })
      .then((svg) => {
        qrCodeHolder.innerHTML = `<img src="data:image/svg+xml;utf8,${encodeURIComponent(svg.replaceAll('<style>.d{fill:currentColor;fill-opacity:.7}</style>', `<style>.d{fill:${getVar(qrCodeHolder, '--text-color')};fill-opacity:.7}</style>`).replace(/<rect\b[^>]*\bfill=["']?#FFFFFF["']?[^>]*\/?>\s*(?:<\/rect>)?/i, ''))}" />`;
        qrCodeHolder.classList.remove('hide');
        qrCodeHolder.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      })
      .catch(console.error);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      let sizeLimit = false;
      if (
        !tempCheck.checked &&
        fileInput.files[0].size > maxSize * 1024 * 1024
      ) {
        sizeLimit = true;
      }

      if (
        tempCheck.checked &&
        fileInput.files[0].size > maxTempSize * 1024 * 1024
      ) {
        sizeLimit = true;
      }

      if (sizeLimit) {
        alert(
          `File too large! Max ${maxSize} MB allowed, and up to ${maxTempSize} MB for temporary uploads`,
        );
        uploadBtn.disabled = true;
        fileName.textContent = '❌ File too large!';
        fileName.classList.add('error');
        fileInput.value = '';
        setTimeout(() => {
          fileName.textContent = defaultFileLabelMessage;
          fileName.classList.remove('error');
        }, 2500);
      } else {
        fileName.textContent = fileInput.files[0].name;
        uploadBtn.disabled = false;
        fileName.classList.remove('error');
      }
    } else {
      fileName.textContent = defaultFileLabelMessage;
      uploadBtn.disabled = true;
      fileName.classList.remove('error');
    }
  });

  tempCheck.addEventListener('change', () => {
    durationSelect.disabled = !tempCheck.checked;

    if (!tempCheck.checked) {
      durationSelect.selectedIndex = 0; // reset
      tempCheckLabel.classList.add('disabled');
    } else {
      tempCheckLabel.classList.remove('disabled');
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault(); // stop normal form submit

    const key = keyInput.value.trim();

    if (!key || fileInput.files.length === 0) {
      alert('Please provide an access key and choose a file.');
      return;
    }

    if (tempCheck.checked && durationSelect.selectedIndex === 0) {
      alert('Please select a duration for the temporary file.');
      return;
    }

    // Build form data
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    if (durationSelect.value && durationSelect.selectedIndex !== 0) {
      formData.append('ttl', parseTime(durationSelect.value));
    }

    uploadFile(key, formData);
  });
});
