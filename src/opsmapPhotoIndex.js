import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedRead, isDay, privateCoverageDirectory } from './shadowCoverage/coverageFiles.js';
import { atomicCoverageWrite } from './shadowCoverage/fileStore.js';
import { DeliveryPhotoError, FRONT_DOOR_PHOTO_KIND, validDeliveryId } from './opsmapDeliveryPhotos.js';

export const INDEX_PHOTO_KINDS = Object.freeze([FRONT_DOOR_PHOTO_KIND, 'REFRIGERATOR_DOOR']);
const DAY = 86400000;
const MAX_FILE = 8 * 1024 * 1024;
const PAGE_SIZE = 24;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCode = value => typeof value === 'string' && /^[A-Z]\d{3,20}$/.test(value);
const fail = (code, status = 503) => { throw new DeliveryPhotoError(code, status); };
const isoDay = time => new Date(time).toISOString().slice(0, 10);
const nextDay = date => isoDay(Date.parse(date) + DAY);
const inRange = (date, range) => date >= range.from && date <= range.through;

function rangeLength({from, through}) {
  if (!isDay(from) || !isDay(through) || through < from || Date.parse(through) - Date.parse(from) > 15000 * DAY) {
    fail('PHOTO_HISTORY_INVALID_RANGE', 400);
  }
  return (Date.parse(through) - Date.parse(from)) / DAY + 1;
}

function dates(range) {
  const start = Date.parse(range.from);
  return Array.from({length:rangeLength(range)}, (_, i) => isoDay(start + i * DAY));
}

// Digests reference independently reviewed retention, store-identity and coverage
// evidence in a private operator manifest. Hub pagination alone cannot certify it.
export function validatePhotoIndexPlan(plan) {
  const scope = {from: plan?.from, through: plan?.through};
  rangeLength(scope);
  if (!validCode(plan.customerCode) || !(plan.retentionProof === null || digest(plan.retentionProof)) ||
      !(plan.identityProof === null || digest(plan.identityProof)) || !Array.isArray(plan.aliases) ||
      !Array.isArray(plan.verifiedRanges) || plan.aliases.length > 64 || plan.verifiedRanges.length > 15001) {
    fail('PHOTO_HISTORY_INVALID_PLAN', 400);
  }
  const currentFrom = plan.currentFrom ?? (plan.aliases.length ? null : scope.from);
  if (!isDay(currentFrom) || !inRange(currentFrom, scope)) fail('PHOTO_HISTORY_INVALID_PLAN', 400);
  const checked = (row, fields) => {
    const range = {from: row?.from, through: row?.through};
    if (!isDay(range.from) || !isDay(range.through) || range.from > range.through ||
        !inRange(range.from, scope) || !inRange(range.through, scope) || !digest(row.evidenceSha256)) {
      fail('PHOTO_HISTORY_INVALID_PLAN', 400);
    }
    return {...fields, ...range, evidenceSha256: row.evidenceSha256};
  };
  const aliases = plan.aliases.map(row => {
    if (!validCode(row?.customerCode) || row.customerCode === plan.customerCode) fail('PHOTO_HISTORY_INVALID_PLAN', 400);
    return checked(row, {customerCode: row.customerCode});
  }).sort((a, b) => a.customerCode.localeCompare(b.customerCode) || a.from.localeCompare(b.from));
  for (let i = 1; i < aliases.length; i++) {
    if (aliases[i].customerCode === aliases[i - 1].customerCode && aliases[i].from <= aliases[i - 1].through) {
      fail('PHOTO_HISTORY_INVALID_PLAN', 400);
    }
  }
  const verifiedRanges = plan.verifiedRanges.map(row => checked(row, {})).sort((a, b) => a.from.localeCompare(b.from));
  if (verifiedRanges.some((range, i) => i > 0 && range.from <= verifiedRanges[i - 1].through)) fail('PHOTO_HISTORY_INVALID_PLAN', 400);
  return {...scope, customerCode: plan.customerCode, currentFrom, retentionProof: plan.retentionProof,
    identityProof: plan.identityProof, aliases, verifiedRanges};
}

function photoRef(photo) {
  const ref = photo?.ref;
  const position = value => Number.isSafeInteger(value) && value >= 0 && value < 32;
  if (!INDEX_PHOTO_KINDS.includes(photo?.kind) || ref?.kind !== photo.kind || ref.history === true ||
      !digest(ref.fingerprint) || !digest(ref.recordFingerprint) || !position(ref.attachmentIndex) ||
      !position(ref.imageIndex) || (ref.childImageIndex !== undefined && !position(ref.childImageIndex)) ||
      (photo.kind === FRONT_DOOR_PHOTO_KIND && !validDeliveryId(photo.recordId))) fail('INVALID_PHOTO_RESPONSE', 502);
  const {kind, attachmentIndex, imageIndex, childImageIndex, fingerprint, recordFingerprint} = ref;
  return {kind, ...(kind === FRONT_DOOR_PHOTO_KIND ? {recordId: String(photo.recordId)} : {}),
    ref: {kind, attachmentIndex, imageIndex, ...(childImageIndex === undefined ? {} : {childImageIndex}), fingerprint, recordFingerprint}};
}

const issueOf = error => error?.code === 'UPSTREAM_AUTH_REQUIRED' || error?.sourceHttpStatus === 401 || error?.status === 401 || error?.upstreamStatus === 401
  ? 'AUTH_REQUIRED' : 'FAILED';
const taskOrder = (a, b) => b.date.localeCompare(a.date) || b.deliveryId.length - a.deliveryId.length || b.deliveryId.localeCompare(a.deliveryId);
const taskMatches = (a, b) => a.customerCode === b.customerCode && a.date === b.date && a.deliveryId === b.deliveryId;
const bindingMatches = (task, plan) => inRange(task.date, plan) && ((task.customerCode === plan.customerCode && task.date >= plan.currentFrom) ||
  plan.aliases.some(alias => alias.customerCode === task.customerCode && inRange(task.date, alias)));

function compactRanges(days) {
  const ranges = [];
  for (const day of days) {
    const last = ranges.at(-1);
    if (last && nextDay(last.through) === day) last.through = day;
    else ranges.push({from: day, through: day});
  }
  return ranges;
}

export function createOpsmapPhotoIndex({directory, appRoot = process.cwd(), now = Date.now} = {}) {
  let root;
  const indexFile = async customerCode => {
    if (!validCode(customerCode)) fail('INVALID_CUSTOMER_CODE', 400);
    root ??= await privateCoverageDirectory(directory, appRoot);
    return path.join(root, `${hash(customerCode)}.json`);
  };
  async function load(file) {
    try {
      if (!(await fs.lstat(file)).isFile()) fail('PHOTO_HISTORY_INDEX_INVALID');
      const bytes = await boundedRead(file, MAX_FILE);
      const value = JSON.parse(bytes.toString('utf8'));
      if (value?.schema !== 1 || !value.plan || !Array.isArray(value.tasks) || !value.discovery) fail('PHOTO_HISTORY_INDEX_INVALID');
      value.plan = validatePhotoIndexPlan(value.plan);
      return {value, generation: hash(bytes)};
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('PHOTO_HISTORY_INDEX_INVALID');
    }
  }
  async function update(plan, work) {
    const file = await indexFile(plan.customerCode);
    const lock = file + '.lock';
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('PHOTO_HISTORY_INDEX_BUSY', 409); throw error; }
    try {
      const prior = (await load(file))?.value;
      if (prior && (prior.plan.customerCode !== plan.customerCode || plan.through < prior.plan.through)) fail('PHOTO_HISTORY_INDEX_CONFLICT', 409);
      const value = await work(prior);
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_FILE) fail('PHOTO_HISTORY_INDEX_TOO_LARGE');
      await atomicCoverageWrite(file, bytes);
      return bytes.length;
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
  async function read({customerCode, cursor = ''}) {
    const saved = await load(await indexFile(customerCode));
    const counts = Object.fromEntries(INDEX_PHOTO_KINDS.map(kind => [kind, 0]));
    if (!saved) {
      if (cursor) fail('PHOTO_HISTORY_CHANGED', 409);
      return {state:'COLLECTING', scope:null, counts, items:[], nextCursor:null};
    }
    const {value, generation} = saved;
    const {plan, tasks, discovery} = value;
    if (plan.customerCode !== customerCode) fail('PHOTO_HISTORY_INDEX_INVALID');
    const checkedDays = dates(plan);
    const badTaskDays = new Set(tasks.filter(task => task.state !== 'CHECKED').map(task => task.date));
    const certified = new Set(plan.verifiedRanges.flatMap(dates));
    const missing = checkedDays.filter(day => discovery[day] !== 'CHECKED' || badTaskDays.has(day) || !certified.has(day) ||
      (day < plan.currentFrom && !plan.aliases.some(alias => inRange(day, alias))));
    const complete = Boolean(plan.retentionProof && plan.identityProof && !missing.length && plan.through >= isoDay(now() + 9 * 3600000));
    const statuses = [...Object.values(discovery), ...tasks.map(task => task.state)];
    const state = statuses.includes('AUTH_REQUIRED') ? 'AUTH_REQUIRED' : statuses.includes('FAILED') ? 'FAILED' : complete ? 'COMPLETE' : 'COLLECTING';
    const [token, rawOffset, extra] = cursor ? cursor.split('.') : [generation, '0'];
    if (token !== generation || extra !== undefined || !/^\d{1,8}$/.test(rawOffset || '')) fail('PHOTO_HISTORY_CHANGED', 409);
    const offset = Number(rawOffset);
    let total = 0;
    const items = [];
    for (const task of tasks) {
      if (!bindingMatches(task, plan) || !validDeliveryId(task.deliveryId) || !Array.isArray(task.photos)) fail('PHOTO_HISTORY_INDEX_INVALID');
      for (const photo of task.photos) {
        if (!INDEX_PHOTO_KINDS.includes(photo.kind)) fail('PHOTO_HISTORY_INDEX_INVALID');
        if (total >= offset && items.length < PAGE_SIZE) {
          items.push({customerCode:task.customerCode, date:task.date, deliveryId:task.deliveryId, photo:photoRef(photo)});
        }
        total++;
        counts[photo.kind]++;
      }
    }
    if (offset && offset >= total) fail('PHOTO_HISTORY_CHANGED', 409);
    const missingRanges = compactRanges(missing);
    return {state, items, counts, scope:{from:plan.from, through:plan.through, earliestRetained:plan.retentionProof ? plan.from : null,
      identityVerified:Boolean(plan.identityProof), missingDays:missing.length, missingRanges:missingRanges.slice(0, 20),
      moreMissingRanges:Math.max(0, missingRanges.length - 20)}, nextCursor:total > offset + items.length ? `${generation}.${offset + items.length}` : null};
  }
  return {read, update};
}

// Run one window at a time outside HTTP reads. Initial jobs skip verified tasks;
// incremental jobs rescan the selected overlap and keep positives on failures.
export function createPhotoIndexCollector({index, readHubCandidates, readTask}) {
  return async ({plan: input, from, through, mode, signal}) => {
    const plan = validatePhotoIndexPlan(input);
    const window = {from, through};
    if (!['initial', 'incremental'].includes(mode) || rangeLength(window) > 31 || !inRange(from, plan) || !inRange(through, plan)) {
      fail('PHOTO_HISTORY_INVALID_RANGE', 400);
    }
    const days = dates(window);
    const stats = {hubReads:0, tasksRead:0, authFailures:0, failures:0};
    const bytes = await index.update(plan, async prior => {
      const sameBindings = prior?.plan.currentFrom === plan.currentFrom && JSON.stringify(prior.plan.aliases) === JSON.stringify(plan.aliases);
      const discovery = Object.fromEntries(Object.entries(sameBindings ? prior.discovery : {}).filter(([date]) => inRange(date, plan)));
      const tasks = new Map((prior?.tasks ?? []).filter(task => bindingMatches(task, plan)).map(task => [task.deliveryId, task]));
      const candidates = new Map();
      try {
        for (const codeRange of [{customerCode:plan.customerCode, from:plan.currentFrom, through:plan.through}, ...plan.aliases]) {
          const startDate = codeRange.from > from ? codeRange.from : from;
          const endDate = codeRange.through < through ? codeRange.through : through;
          if (startDate > endDate) continue;
          signal?.throwIfAborted();
          stats.hubReads++;
          const rows = await readHubCandidates({customerCode:codeRange.customerCode, startDate, endDate}, {signal});
          if (!Array.isArray(rows)) fail('PHOTO_HISTORY_HUB_INCOMPLETE');
          for (const row of rows) {
            const task = {customerCode:codeRange.customerCode, date:row.deliveryDate, deliveryId:String(row.deliveryId)};
            const existing = candidates.get(task.deliveryId) ?? tasks.get(task.deliveryId);
            if (!validDeliveryId(row.deliveryId) || !isDay(task.date) || task.date < startDate || task.date > endDate ||
                (row.customerCode !== undefined && row.customerCode !== task.customerCode) || (existing && !taskMatches(existing, task))) {
              fail('PHOTO_HISTORY_HUB_INCOMPLETE');
            }
            candidates.set(task.deliveryId, task);
          }
        }
        for (const day of days) discovery[day] = 'CHECKED';
      } catch (error) {
        signal?.throwIfAborted();
        const state = issueOf(error);
        stats[state === 'AUTH_REQUIRED' ? 'authFailures' : 'failures']++;
        for (const day of days) discovery[day] = state;
        return {schema:1, plan, discovery, tasks:[...tasks.values()].sort(taskOrder)};
      }
      for (const [id, task] of candidates) if (!tasks.has(id)) tasks.set(id, {...task, state:'PENDING', photos:[]});
      for (const [id, task] of tasks) {
        if (!inRange(task.date, window) || (mode === 'initial' && task.state === 'CHECKED')) continue;
        signal?.throwIfAborted();
        stats.tasksRead++;
        try {
          const row = await readTask(task, {signal});
          if (!row || !taskMatches(row, task) || !Array.isArray(row.photos) ||
              !['READY','EMPTY','UNVERIFIED'].includes(row.status) || (row.status === 'EMPTY' && row.photos.length)) {
            fail('INVALID_PHOTO_RESPONSE', 502);
          }
          const photos = row.photos.filter(photo => INDEX_PHOTO_KINDS.includes(photo.kind)).map(photoRef);
          const known = row.status === 'UNVERIFIED' ? [...task.photos, ...photos] : photos;
          const unique = new Map(known.map(photo => [`${photo.kind}:${photo.ref.fingerprint}`, photo]));
          tasks.set(id, {...task, state:row.status === 'UNVERIFIED' ? 'UNVERIFIED' : 'CHECKED', photos:[...unique.values()]});
        } catch (error) {
          signal?.throwIfAborted();
          const state = issueOf(error);
          tasks.set(id, {...task, state});
          stats[state === 'AUTH_REQUIRED' ? 'authFailures' : 'failures']++;
          // Stop on account expiry or rate limiting instead of hitting every task.
          if (state === 'AUTH_REQUIRED' || error?.status === 429 || error?.code === 'PHOTO_RATE_LIMITED') break;
        }
      }
      signal?.throwIfAborted();
      return {schema:1, plan, discovery, tasks:[...tasks.values()].sort(taskOrder)};
    });
    return {...stats, indexBytes:bytes};
  };
}
