import crypto from 'node:crypto';

const sessionReadTtlMs = 4000;
const repositoryCheckTtlMs = 60000;
const maxSessions = 1000;
const maxStateBytes = 512000;

// Stage-only, isolated from the coordinate file and all Production branches.
export function createStageStaffSessionStore({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (env.OPSMAP_STAGE_VERIFY_ONLY !== '1') return undefined;
  if (env.GITHUB_CACHE_REPO !== 'mingu0702-droid/freshon-cache' || !env.GITHUB_TOKEN ||
      env.OPSMAP_MANUAL_PIN_GITHUB_BRANCH !== 'stage/opsmap-manual-pins' || !env.MAP_STAFF_SESSION_SECRET) {
    throw Error('STAFF_SESSION_STORE_CONFIG');
  }
  const root = 'https://api.github.com/repos/' + env.GITHUB_CACHE_REPO;
  const branch = 'stage/opsmap-manual-pins';
  const file = root + '/contents/opsmap-stage/staff-sessions-v1.json';
  const headers = { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json', 'User-Agent': 'opsmap-stage-staff-session' };
  const logged = new Map();
  const stats = { repositoryReads: 0, sessionReads: 0, sessionWrites: 0,
    cacheHits: 0, joinedReads: 0, notModified: 0, cooldownSkips: 0 };
  let repository = null, snapshot = null, pendingRead = null, writeTail = Promise.resolve(), blockedUntil = 0;

  function numericHeader(response, name) {
    const value = response?.headers?.get(name);
    return /^\d{1,12}$/.test(value || '') ? Number(value) : null;
  }
  function unavailable() {
    return Object.assign(Error('STAFF_SESSION_STORE_UNAVAILABLE'), { retryAfterMs: Math.max(0, blockedUntil - now()) });
  }
  function ensureAvailable() {
    if (now() >= blockedUntil) return;
    stats.cooldownSkips++;
    throw unavailable();
  }
  function fail(step, response) {
    const at = now(), status = Number(response?.status) || null;
    const rateRemaining = numericHeader(response, 'x-ratelimit-remaining');
    const rateReset = numericHeader(response, 'x-ratelimit-reset');
    const retryAfter = numericHeader(response, 'retry-after');
    if ((status === 403 || status === 429) && (rateRemaining === 0 || retryAfter !== null || status === 429)) {
      const resetAt = rateRemaining === 0 && rateReset !== null ? rateReset * 1000 : 0;
      const retryAt = retryAfter !== null ? at + retryAfter * 1000 : 0;
      blockedUntil = Math.max(blockedUntil, resetAt, retryAt, at + (resetAt || retryAt ? 1000 : 60000));
    }
    const tag = step + ':' + status;
    if (!logged.has(tag) || at - logged.get(tag) >= 30000) {
      logged.set(tag, at);
      console.warn(JSON.stringify({ event: 'STAGE_STAFF_STORE_UNAVAILABLE', step, status, rateRemaining, rateReset, retryAfter }));
    }
    throw unavailable();
  }
  const mac = value => crypto.createHmac('sha256', env.MAP_STAFF_SESSION_SECRET)
    .update('staff-session-v1:' + JSON.stringify(value)).digest('hex');

  async function request(url, metric, { etag, ...options } = {}) {
    ensureAvailable();
    stats[metric]++;
    const requestHeaders = etag ? { ...headers, 'If-None-Match': etag } : headers;
    try {
      return await fetchImpl(url, { ...options, headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch { fail('TRANSPORT'); }
  }
  async function verifyRepository(force = false) {
    if (!force && repository?.until > now()) return;
    const previous = repository;
    repository = null;
    const response = await request(root, 'repositoryReads', { etag: previous?.etag });
    if (response.status === 304 && previous?.etag) {
      stats.notModified++;
      repository = { ...previous, until: now() + repositoryCheckTtlMs };
      return;
    }
    if (!response.ok) fail('REPOSITORY_HTTP', response);
    let repo;
    try { repo = await response.json(); } catch { fail('REPOSITORY_JSON', response); }
    if (repo?.private !== true || repo.permissions?.push !== true) fail('REPOSITORY_SCOPE', response);
    repository = { etag: response.headers?.get('etag'), until: now() + repositoryCheckTtlMs };
  }
  async function readFile() {
    const previous = snapshot;
    snapshot = null;
    const response = await request(file + '?ref=' + encodeURIComponent(branch), 'sessionReads', { etag: previous?.etag });
    if (response.status === 304 && previous?.etag) {
      stats.notModified++;
      snapshot = { ...previous, until: now() + sessionReadTtlMs };
      return snapshot;
    }
    let sha = null, state = { schema: 1, sessions: {} };
    if (response.status !== 404) {
      if (!response.ok) fail('STATE_HTTP', response);
      let data;
      try { data = await response.json(); } catch { fail('STATE_JSON', response); }
      if (data?.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(data.sha || '') || data.size > maxStateBytes) fail('STATE_FORMAT', response);
      try {
        const bytes = Buffer.from(data.content, 'base64');
        if (bytes.length > maxStateBytes) throw Error('SIZE');
        state = JSON.parse(bytes.toString('utf8'));
      } catch { fail('STATE_DECODE', response); }
      if (state?.schema !== 1 || !state.sessions || typeof state.sessions !== 'object' ||
          Array.isArray(state.sessions) || Object.keys(state.sessions).length > maxSessions) fail('STATE_SCHEMA', response);
      sha = data.sha;
    }
    snapshot = { sha, state, etag: sha && response.headers?.get('etag'), until: now() + sessionReadTtlMs };
    return snapshot;
  }
  function valid(key, entry, at) {
    if (!entry || !/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(entry.expiresAt) ||
        !Number.isFinite(entry.idleExpiresAt) || entry.idleExpiresAt > entry.expiresAt || at >= entry.idleExpiresAt) return false;
    const { signature, ...body } = entry;
    return /^[a-f0-9]{64}$/.test(signature || '') &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mac({ key, ...body })));
  }
  async function sharedRead() {
    ensureAvailable();
    if (pendingRead) {
      stats.joinedReads++;
      return pendingRead;
    }
    const at = now();
    if (repository?.until > at && snapshot?.until > at) {
      stats.cacheHits++;
      return snapshot;
    }
    const task = verifyRepository().then(() => readFile());
    pendingRead = task;
    try { return await task; } finally { if (pendingRead === task) pendingRead = null; }
  }
  function write(key, entry, requireExisting = false) {
    const work = writeTail.catch(() => {}).then(async () => {
      await pendingRead?.catch(() => {});
      // Recheck private scope and the current revision before writing.
      await verifyRepository(true);
      const current = await readFile(), { sha } = current;
      const state = structuredClone(current.state), at = now();
      for (const [id, value] of Object.entries(state.sessions)) if (!valid(id, value, at)) delete state.sessions[id];
      if (requireExisting && (state.sessions[key]?.fingerprint !== entry.fingerprint ||
          state.credentialFingerprint !== entry.fingerprint)) return false;
      if (!entry && !current.state.sessions[key]) return true;
      if (entry) {
        if (state.credentialFingerprint !== entry.fingerprint) {
          state.sessions = {};
          state.credentialFingerprint = entry.fingerprint;
        }
        if (Object.keys(state.sessions).length >= maxSessions && !state.sessions[key]) fail('STATE_CAPACITY');
        state.sessions[key] = { ...entry, signature: mac({ key, ...entry }) };
      } else {
        delete state.sessions[key];
      }
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > maxStateBytes) fail('STATE_CAPACITY');
      snapshot = null;
      const response = await request(file, 'sessionWrites', { method: 'PUT', body: JSON.stringify({
        message: 'Update isolated Stage staff session metadata', branch, ...(sha ? { sha } : {}), content: bytes.toString('base64')
      }) });
      if (!response.ok) fail('CAS_HTTP', response);
      const saved = await readFile();
      if ((entry && saved.state.credentialFingerprint !== entry.fingerprint) ||
          JSON.stringify(saved.state.sessions[key] || null) !== JSON.stringify(state.sessions[key] || null)) {
        snapshot = null;
        fail('CAS_READBACK');
      }
      return true;
    });
    writeTail = work;
    return work;
  }
  return {
    kind: 'PRIVATE_GITHUB_CAS',
    stats: () => ({ ...stats }),
    async get(key, fingerprint) {
      for (;;) {
        const barrier = writeTail;
        await barrier.catch(() => {});
        if (barrier !== writeTail) continue;
        const { state } = await sharedRead();
        if (barrier !== writeTail) continue;
        const entry = state.sessions[key];
        if (state.credentialFingerprint !== fingerprint || entry?.fingerprint !== fingerprint || !valid(key, entry, now())) return null;
        return { expiresAt: entry.expiresAt, idleExpiresAt: entry.idleExpiresAt };
      }
    },
    set: (key, session, fingerprint) => write(key, { ...session, fingerprint }),
    touch: (key, session, fingerprint) => write(key, { ...session, fingerprint }, true),
    delete: key => write(key, null)
  };
}
