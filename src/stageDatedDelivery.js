import {createOperationalPhotoTaskReader} from './opsmapOperationalPhotoTaskReader.js';
import {assertDeliverySourceObservation, deliverySourceObservation} from './snapshotRefreshEvidence.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageAbValidation.js';

const deliveryOrigin = 'https://delivery-bali.chabyulhwa.com';
const error = (code, status) => Object.assign(Error(code), {code, diagnostic:{status}});
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const field = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() || '';

function taskVehicle(task) {
  const carrier = task.carrier || task.carrierInfo || task.driver || {};
  const raw = [task.fixedNo, task.fixed_no, task.fixedNumber, task.fixedVehicleNo, task.carrierNo, task.vehicleNo,
    task.vehicle, carrier.fixedNo, carrier.fixed_no, carrier.fixedNumber, carrier.carrierNo, carrier.vehicleNo, carrier.name];
  const vehicle = field(...raw.map(value => Number.isSafeInteger(value) ? String(value) : value)).replace(/\s+/g, '').replace(/(?:호차|호|번)$/, '');
  return /^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/.test(vehicle) ? vehicle : '';
}

export function createStageDatedDeliveryReader({env = process.env, fetchImpl = fetch} = {}) {
  const enabled = env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.RENDER_SERVICE_ID === STAGE_SERVICE &&
    env.OPSMAP_STAGE_DELIVERY_DATED_ENABLED === '1';
  const cookie = String(env.OPSMAP_STAGE_DELIVERY_DATED_COOKIE || '').trim();
  const read = createOperationalPhotoTaskReader({async rawRequest(path, {method, signal}) {
    const url = new URL(path, deliveryOrigin);
    if (method !== 'GET' || url.origin !== deliveryOrigin || url.pathname !== '/api/bali/task' || url.hash || url.username || url.password) {
      throw error('DELIVERY_SOURCE_REQUEST_REJECTED', 403);
    }
    return fetchImpl(url, {method, signal, redirect:'error', cache:'no-store', headers:{Accept:'application/json', Cookie:cookie}});
  }});

  const inflight = new Map();
  let cached;
  async function loadDate(date) {
    let tasks;
    try { tasks = await read(date); }
    catch (failure) {
      const code = ({UPSTREAM_AUTH_REQUIRED:'DELIVERY_SOURCE_AUTH_REQUIRED', PHOTO_FORBIDDEN:'DELIVERY_SOURCE_FORBIDDEN',
        PHOTO_TIMEOUT:'DELIVERY_SOURCE_TIMEOUT', PHOTO_RATE_LIMITED:'DELIVERY_SOURCE_RATE_LIMITED',
        PHOTO_IDENTITY_UNVERIFIED:'DELIVERY_SOURCE_IDENTITY_UNVERIFIED'})[failure?.code] || 'DELIVERY_SOURCE_READ_UNAVAILABLE';
      throw error(code, failure?.sourceHttpStatus ?? failure?.status ?? 502);
    }
    const observation = deliverySourceObservation(tasks, {date, complete:tasks.sourceObservation.complete,
      pages:tasks.sourceObservation.pages, resolveVehicle:taskVehicle});
    assertDeliverySourceObservation(observation, date);
    const groups = new Map();
    for (const task of tasks) {
      const vehicle = taskVehicle(task) || '미확인';
      const customer = task.customer || {}, location = task.location || {};
      const stops = groups.get(vehicle) || [];
      const deliveryStatus = field(task.status, task.taskStatus);
      const deliveryCompletedAt = field(task.completedAt, task.completeDatedAt, task.deliveryCompletedAt);
      stops.push({customerCode:task.customer?.erpCode ?? task.customerErpCode,
        customerName:field(task.customerName, customer.name),
        address:field(task.customerAddress, task.address, customer.address, location.address),
        sequence:stops.length + 1, deliveryStatus, deliveryCompletedAt,
        appRecorded:Boolean(deliveryCompletedAt) || deliveryStatus === 'COMPLETED'});
      groups.set(vehicle, stops);
    }
    return {date, generatedAt:new Date().toISOString(), sourceObservation:observation,
      vehicles:[...groups].map(([vehicle, stops]) => {
        const completedStops = stops.filter(stop => stop.appRecorded).length;
        return {vehicle, stops, totalStops:stops.length, completedStops, remainingStops:stops.length - completedStops,
          status:completedStops === stops.length ? '완료' : completedStops ? '배송중' : '출차전'};
      })};
  }

  return async function readDate(date) {
    if (!enabled) throw error('DELIVERY_SOURCE_READ_ONLY', 503);
    if (!/^[\x20-\x7e]{1,8192}$/.test(cookie)) throw error('DELIVERY_SOURCE_SESSION_REQUIRED', 401);
    if (!validDate(date)) throw error('DELIVERY_SOURCE_DATE_INVALID', 400);
    if (cached?.date === date && cached.expiresAt > Date.now()) return cached.value;
    if (inflight.has(date)) return inflight.get(date);
    if (inflight.size >= 2) throw error('DELIVERY_SOURCE_BUSY', 429);
    const pending = loadDate(date).then(value => {
      cached = {date, value, expiresAt:Date.now() + 60000};
      return value;
    }).finally(() => inflight.delete(date));
    inflight.set(date, pending);
    return pending;
  };
}
