// Follow only the configured execution endpoint and Google's output redirect.
// A temporary exec redirect must not silently turn an authenticated POST into
// an unauthenticated health GET. Never send the signed body to the output host.
export async function fetchPrivateHub(url, options, profile) {
  const execution = new URL(url); let current = execution, method = 'POST';
  profile.redirects = [];
  profile.hops = [];
  for (let hop = 0; hop <= 4; hop++) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    profile.phase = 'HEADERS';
    const response = await fetch(current.href, { ...options, method,
      body: method === 'POST' ? options.body : undefined,
      headers: method === 'POST' ? options.headers : {}, redirect: 'manual' });
    profile.responseHeadersMs = (profile.responseHeadersMs || 0) + performance.now() - started;
    profile.upstreamStatus = response.status;
    profile.hops.push({target:current.origin===execution.origin?'EXEC':'OUTPUT',method,status:response.status,headersMs:Math.round((performance.now()-started)*100)/100});
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === 4) throw Object.assign(new Error('DETAIL_REDIRECT_INVALID'), {failureType:'contract'});
    const next = new URL(location, current);
    const sameExecution = next.origin === execution.origin && next.pathname === execution.pathname;
    const output = next.protocol === 'https:' && next.hostname === 'script.googleusercontent.com' && next.pathname === '/macros/echo';
    const nextMethod = sameExecution && method === 'POST' ? 'POST' : output ? 'GET' : null;
    profile.redirects.push({status:response.status,from:method,to:nextMethod || 'BLOCKED',target:sameExecution?'EXEC':output?'OUTPUT':'OTHER',
      blockedKind:nextMethod?null:next.hostname==='accounts.google.com'?'LOGIN':next.hostname==='script.google.com'?'GOOGLE_EXEC_OTHER':next.hostname==='script.googleusercontent.com'?'GOOGLE_OUTPUT_OTHER':'UNTRUSTED'});
    if (!nextMethod) throw Object.assign(new Error('DETAIL_REDIRECT_REJECTED'), {failureType:next.hostname==='accounts.google.com'?'auth':'contract',upstreamStatus:response.status});
    current = next; method = nextMethod;
  }
}

export function privateResponseKind(text, parsed) {
  if (parsed?.data?.service === 'hub-map-api' && parsed?.data?.status === 'UP') return 'health-json';
  if (parsed && typeof parsed === 'object') return 'json';
  return /^\s*</.test(text || '') ? 'html' : 'invalid-json';
}
