import {deliveryDate, DeliveryPhotoError} from './opsmapDeliveryPhotos.js';
import {deliveryPhotoUpstreamError} from './opsmapDeliveryAdminTransport.js';
import {createOperationalPhotoExtension, createOperationalPhotoMetadataReader, createOperationalPhotoTaskReader} from './opsmapOperationalPhotos.js';
import {mountDeliveryPhotoConfig} from './opsmapDeliveryPhotoRouter.js';
import {createStageDeliveryAdminPhotoSession, STAGE_DELIVERY_ORIGIN} from './opsmapStageDeliveryAdminSession.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';
import {createOpsmapPhotoIndex} from './opsmapPhotoIndex.js';
const DAY_MS = 86400000;
const validSecret = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);

function taskSearchAllowed(url) {
  if (url.pathname !== '/api/bali/task') return false;
  const query = url.searchParams;
  const dates = query.getAll('enteringDatedAtBetween');
  if (dates.length !== 2 || dates.some(value => value !== deliveryDate(value) + 'T00:00:00+09:00')
    || !/^[A-Za-z0-9_-]{1,64}$/.test(query.get('customerErpCodeLike') || '')
    || !/^[0-3]$/.test(query.get('page') || '') || query.get('pageSize') !== '50') return false;
  const span = Date.parse(dates[1]) - Date.parse(dates[0]);
  if (query.size === 5) return span === 0;
  return query.size === 7 && span >= 0 && span <= 364 * DAY_MS
    && query.get('statusIn') === 'COMPLETED' && query.get('completeTypeIn') === 'FRONT_DOOR';
}

export function createStageOperationalPhotoExtension({env = process.env, fetchImpl = globalThis.fetch, defaultDate, now = Date.now} = {}) {
  const dedicatedAccount = env.OPSMAP_STAGE_DELIVERY_PHOTO_AUTH_ENABLED === '1';
  const approvedExistingAccount = !dedicatedAccount && env.OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN === '1';
  const accountMode = dedicatedAccount || approvedExistingAccount;
  const id = dedicatedAccount ? env.OPSMAP_STAGE_DELIVERY_PHOTO_ID : env.DELIVERY_ADMIN_ID;
  const password = dedicatedAccount ? env.OPSMAP_STAGE_DELIVERY_PHOTO_PASSWORD : env.DELIVERY_ADMIN_PASSWORD;
  const approvedStage = env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.RENDER_SERVICE_ID === STAGE_SERVICE;
  const historyDirectory = approvedStage ? env.OPSMAP_PHOTO_HISTORY_DIRECTORY : null;
  const historyIndex = historyDirectory ? createOpsmapPhotoIndex({directory:historyDirectory, now}) : null;
  const readIndexedHistory = approvedStage ? async query => {
    if (!historyIndex) throw new DeliveryPhotoError('PHOTO_HISTORY_NOT_CONFIGURED', 503, {stage:'source-index'});
    try { return await historyIndex.read(query); }
    catch (error) {
      if (error instanceof DeliveryPhotoError) throw error;
      throw new DeliveryPhotoError('PHOTO_HISTORY_INDEX_UNAVAILABLE', 503, {stage:'source-index'});
    }
  } : undefined;
  const account = accountMode && approvedStage && validSecret(id, 256) && validSecret(password, 1024)
    ? createStageDeliveryAdminPhotoSession({id, password, fetchImpl, now}) : null;
  const cookie = accountMode ? '' : String(env.OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE || '').trim();
  const cookieConfigured = /^[\x20-\x7e]{1,8192}$/.test(cookie);
  const enabled = () => env.OPSMAP_STAGE_DELIVERY_PHOTOS_ENABLED !== '0';
  let legacyState = cookieConfigured ? 'NOT_VERIFIED' : 'NOT_CONFIGURED';

  const rawRequest = async (path, {method, signal} = {}) => {
    const url = new URL(path, STAGE_DELIVERY_ORIGIN);
    const detail = /^\/api\/bali\/task\/\d{1,20}(?:\/status-record)?$/.test(url.pathname) && !url.search;
    if (method !== 'GET' || url.origin !== STAGE_DELIVERY_ORIGIN || url.username || url.password || url.hash
      || (!detail && !taskSearchAllowed(url))) throw new DeliveryPhotoError('INVALID_PHOTO_REQUEST', 400);
    if (account) return account.read(url, {signal});
    if (legacyState === 'AUTH_REQUIRED') throw deliveryPhotoUpstreamError(401);
    const response = await fetchImpl(url, {
      method, signal, redirect:'error', cache:'no-store', headers:{Accept:'application/json', Cookie:cookie}
    });
    if (response?.status === 401) legacyState = 'AUTH_REQUIRED';
    return response;
  };

  const listDeliveryMetadata = createOperationalPhotoMetadataReader({
    readTaskRows:createOperationalPhotoTaskReader({rawRequest, customerScoped:true}), defaultDate, customerScoped:true
  });
  const extension = createOperationalPhotoExtension({
    enabled, rawRequest:account || cookieConfigured ? rawRequest : undefined,
    hasMemorySession:account?.hasSession ?? (() => cookieConfigured), prepareSession:account?.prepareSession,
    canPrepareSource:() => Boolean(account), prepareHistorySession:Boolean(account), prepareMediaSession:Boolean(account),
    listDeliveryMetadata, imageFetch:fetchImpl,
    readIndexedHistory,
    onSourceVerified:() => {
      if (account) account.markVerified();
      else if (legacyState !== 'AUTH_REQUIRED') legacyState = 'VERIFIED';
    }
  });
  const diagnostics = () => {
    const sourceAuth = accountMode ? account?.sourceState() ?? 'NOT_CONFIGURED' : legacyState;
    return {enabled:enabled(), cookieConfigured, sourceSession:enabled() && sourceAuth === 'VERIFIED', sourceAuth, metadataConfigured:true,
      indexedHistoryConfigured:Boolean(historyDirectory),
      ...(accountMode ? {authMode:'APPROVED_ACCOUNT', credentialsConfigured:Boolean(account)} : {})};
  };
  return {
    diagnostics,
    readIndexTask:extension.readIndexTask,
    mount(binding) {
      mountDeliveryPhotoConfig(binding, diagnostics);
      return extension.mount(binding);
    }
  };
}
