export function finishedDraft(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /[!?.,]$/.test(text) ? `${text} ` : `${text}. `;
}
