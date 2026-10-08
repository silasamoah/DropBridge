// Replace or extend this adapter with a native clipboard agent later.
export async function copyText(text) {
  if (!navigator.clipboard || !window.isSecureContext) throw new Error('Automatic copy needs HTTPS or localhost. Select the received text and copy it manually.');
  try { await navigator.clipboard.writeText(text); }
  catch { throw new Error('Clipboard permission denied. Select the received text and copy it manually.'); }
}
