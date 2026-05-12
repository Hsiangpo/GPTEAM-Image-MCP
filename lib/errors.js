export function formatNetworkError(error) {
  const details = [];
  const message = error && error.message ? String(error.message) : String(error || 'network error');
  if (message) details.push(message);

  let cause = error && error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    const causeDetails = [
      cause.code,
      cause.errno && cause.errno !== cause.code ? cause.errno : '',
      cause.syscall,
      cause.hostname,
      cause.address,
      cause.port ? `port ${cause.port}` : ''
    ].filter(Boolean);
    if (cause.message && cause.message !== message) causeDetails.push(cause.message);
    if (causeDetails.length) details.push(causeDetails.join(' '));
    cause = cause.cause;
  }

  return [...new Set(details)].join('，') || 'network error';
}
