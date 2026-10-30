// Candidate only: replace this exact function in the verified Hub v64 HubSearch module.
// Do not add a second global definition or install this file as a new module.
function hubSearchObjects_(response) {
  // Reuse v64's existing decoder; both table rows and object responses are valid.
  if (typeof hubMapHttpObjects_ === 'function') return hubMapHttpObjects_(response);
  const data = response && response.data || {};
  const headers = Array.isArray(data.headers) ? data.headers : [];
  return (Array.isArray(data.rows) ? data.rows : []).map(function (row) {
    const out = {};
    headers.forEach(function (header, index) { out[String(header)] = row[index]; });
    return out;
  });
}
