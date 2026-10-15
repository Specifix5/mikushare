export const historyTokenKey = 'miku:history-token';
export const storedHistoryToken = () => {
  try {
    return sessionStorage.getItem(historyTokenKey) || '';
  } catch {
    return '';
  }
};
export const clearHistoryToken = () => {
  try {
    sessionStorage.removeItem(historyTokenKey);
  } catch {
    /* Storage may be disabled. */
  }
};
export const setupHistoryAccess = (input, button) => {
  let timer,
    controller,
    allowedToken = '';
  const reset = () => {
    clearTimeout(timer);
    controller?.abort();
    button.hidden = true;
    allowedToken = '';
    clearHistoryToken();
  };
  const check = async () => {
    reset();
    const token = input.value.trim();
    if (!token) return;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const response = await fetch('/account/info', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal,
      });
      if (!response.ok) return;
      const account = await response.json();
      if (
        !signal.aborted &&
        input.value.trim() === token &&
        account.public === false
      ) {
        allowedToken = token;
        button.hidden = false;
      }
    } catch {
      /* Invalid tokens and network failures keep history hidden. */
    }
  };
  button.addEventListener('click', () => {
    if (!allowedToken || input.value.trim() !== allowedToken) return;
    try {
      sessionStorage.setItem(historyTokenKey, allowedToken);
    } catch {
      return;
    }
    location.assign('/account/history');
  });
  const scheduleCheck = () => {
    reset();
    if (input.value.trim()) timer = setTimeout(() => void check(), 250);
  };
  input.addEventListener('input', scheduleCheck);
  input.addEventListener('change', () => {
    if (input.value.trim() !== allowedToken) scheduleCheck();
  });
  window.addEventListener('pageshow', scheduleCheck);
  scheduleCheck();
};
