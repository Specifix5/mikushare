const units = { d: 24, h: 1 }; // in hours

const parseTime = (str) => {
  return Array.from(str.matchAll(/(\d+)([dh])/g))
    .map(([_, num, unit]) => +num * units[unit])
    .reduce((a, b) => a + b, 0);
};

const defaultFileLabelMessage = 'Browse... (Max 65MB, Temp 95MB)';

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

  copyBtn.addEventListener('click', async () => {
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
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      let sizeLimit = false;
      if (!tempCheck.checked && fileInput.files[0].size > 65 * 1024 * 1024) {
        sizeLimit = true;
      }

      if (tempCheck.checked && fileInput.files[0].size > 95 * 1024 * 1024) {
        sizeLimit = true;
      }

      if (sizeLimit) {
        alert(
          'File too large! Max 65 MB allowed, and up to 95 MB for temporary uploads',
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

    try {
      uploadBtn.disabled = true;
      outputLabel.classList.remove('hide');
      outputLabel.textContent = 'Uploading...';

      const res = await fetch(`/upload?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const data = await res.json();

      if (data.url) {
        /*try {
          // Copy to clipboard
          await navigator.clipboard.writeText(data.url);
          alert(`☑️ File uploaded! URL copied to clipboard:\n${data.url}`);
        } catch (err) {
          console.error('Failed to copy to clipboard:', err);
          alert(`❌ Failed to copy to clipboard: ${err.message}`);
        }*/
        outputLabel.textContent = data.url ?? '';
        copyBtnSvgs.forEach((svg) => {
          svg.classList.remove('hide');
        });

        fileInput.value = '';
        fileName.textContent = defaultFileLabelMessage;
      } else {
        throw new Error('No URL in response');
      }
    } catch (err) {
      console.error(err);
      alert('Upload error: ' + err.message);

      fileInput.value = '';
      fileName.textContent = '❌ ' + err.message;
      fileName.classList.add('error');
      uploadBtn.disabled = false;
    }
  });
});
