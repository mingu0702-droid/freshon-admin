import {deliveryDate, DeliveryPhotoError} from './opsmapDeliveryPhotos.js';
import {deliveryPhotoUpstreamError} from './opsmapDeliveryAdminTransport.js';
import {createOperationalPhotoExtension, createOperationalPhotoMetadataReader, createOperationalPhotoTaskReader} from './opsmapOperationalPhotos.js';
import {mountDeliveryPhotoConfig} from './opsmapDeliveryPhotoRouter.js';

const SOURCE_ORIGIN = 'https://delivery-bali.chabyulhwa.com';
const DAY_MS = 86400000;

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

export function createStageOperationalPhotoExtension({env = process.env, fetchImpl = globalThis.fetch, defaultDate} = {}) {
  const cookie = String(env.OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE || '').trim();
  const cookieConfigured = /^[\x20-\x7e]{1,8192}$/.test(cookie);
  const enabled = () => env.OPSMAP_STAGE_DELIVERY_PHOTOS_ENABLED !== '0';
  let sourceAuth = cookieConfigured ? 'NOT_VERIFIED' : 'NOT_CONFIGURED';

  const rawRequest = async (path, {method, signal} = {}) => {
    const url = new URL(path, SOURCE_ORIGIN);
    const detail = /^\/api\/bali\/task\/\d{1,20}(?:\/status-record)?$/.test(url.pathname) && !url.search;
    if (method !== 'GET' || url.origin !== SOURCE_ORIGIN || url.username || url.password || url.hash
      || (!detail && !taskSearchAllowed(url))) throw new DeliveryPhotoError('INVALID_PHOTO_REQUEST', 400);
    if (sourceAuth === 'AUTH_REQUIRED') throw deliveryPhotoUpstreamError(401);
    const response = await fetchImpl(url, {
      method, signal, redirect:'error', cache:'no-store', headers:{Accept:'application/json', Cookie:cookie}
    });
    if (response?.status === 401) sourceAuth = 'AUTH_REQUIRED';
    return response;
  };

  const listDeliveryMetadata = createOperationalPhotoMetadataReader({
    readTaskRows:createOperationalPhotoTaskReader({rawRequest, customerScoped:true}), defaultDate, customerScoped:true
  });
  const extension = createOperationalPhotoExtension({
    enabled, rawRequest:cookieConfigured ? rawRequest : undefined, hasMemorySession:() => cookieConfigured,
    listDeliveryMetadata, imageFetch:fetchImpl, onSourceVerified:() => {
      if (sourceAuth !== 'AUTH_REQUIRED') sourceAuth = 'VERIFIED';
    }
  });
  const diagnostics = () => ({
    enabled:enabled(), cookieConfigured, sourceSession:enabled() && sourceAuth === 'VERIFIED', sourceAuth, metadataConfigured:true
  });
  return {
    diagnostics,
    mount(binding) {
      mountDeliveryPhotoConfig(binding, diagnostics);
      return extension.mount(binding);
    }
  };
}
