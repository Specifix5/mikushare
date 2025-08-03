document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('uploadForm');
  const fileInput = document.getElementById('file');
  const keyInput = document.getElementById('key');
  const fileName = document.getElementById('file-name');
  const uploadBtn = document.getElementById('uploadButton');

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      if (fileInput.files[0].size > 64 * 1024 * 1024) {
        alert('File too large! Max 64 MB allowed.');
        uploadBtn.disabled = true;
        fileName.textContent = '❌ File too large!';
        fileName.classList.add('error');
        fileInput.value = '';
      } else {
        fileName.textContent = fileInput.files[0].name;
        uploadBtn.disabled = false;
        fileName.classList.remove('error');
      }
    } else {
      fileName.textContent = 'No file selected';
      uploadBtn.disabled = true;
      fileName.classList.remove('error');
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault(); // stop normal form submit

    const key = keyInput.value.trim();

    if (!key || fileInput.files.length === 0) {
      alert('Please provide an access key and choose a file.');
      return;
    }

    // Build form data
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
      uploadBtn.disabled = true;
      const res = await fetch(`/upload?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const data = await res.json();

      if (data.url) {
        try {
          // Copy to clipboard
          await navigator.clipboard.writeText(data.url);
          alert(`☑️ File uploaded! URL copied to clipboard:\n${data.url}`);
        } catch (err) {
          console.error('Failed to copy to clipboard:', err);
          alert(`❌ Failed to copy to clipboard: ${err.message}`);
        }
        fileName.innerHTML = `<a href="${data.url}" target="_blank">${data.url}</a>`;

        fileInput.value = '';
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
