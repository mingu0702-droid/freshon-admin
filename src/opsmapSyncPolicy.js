// Publication is not proof that every required source was read successfully.
export const SYNC_CENTERS = Object.freeze(['osan','yeongnam','honam']);
// FreshOn B218: 1 is parcel, 2 is night dispatch, and 3 is day dispatch.
export const FRESHON_NIGHT_DISPATCH = '2';
export const FRESHON_NIGHT_DISPATCH_LABEL = '야간배송';
export const SYNC_DELIVERY_SOURCES = Object.freeze({osan:'1',osanColdStorage:'2',yeongnam:'3',honam:'4'});
export const STAGE_OSAN_SYNC_CENTERS = Object.freeze({osan:SYNC_DELIVERY_SOURCES.osan});
export const STAGE_OSAN_SYNC_SOURCE_IDS = Object.freeze(Object.values(STAGE_OSAN_SYNC_CENTERS));
export function completeSyncObservation(day, requiredCenters = SYNC_CENTERS, requiredSources = []) {
  if (!day || day.planningOnly || day.proof !== 'VERIFIED_COMPLETE_DAY' || !Array.isArray(requiredCenters) || !requiredCenters.length ||
      requiredCenters.some(c => !SYNC_CENTERS.includes(c)) || new Set(requiredCenters).size !== requiredCenters.length ||
      !Array.isArray(day.completeCenters) || new Set(day.completeCenters).size !== day.completeCenters.length ||
      day.unidentified !== 0 || !Number.isSafeInteger(day.sourceRows) || day.sourceRows < 0 ||
      !Array.isArray(day.tasks) || day.tasks.length !== day.sourceRows) return false;
  return requiredCenters.every(c => day.completeCenters.includes(c)) &&
    (!requiredSources.length || Array.isArray(day.completeSources) && requiredSources.every(id=>day.completeSources.includes(id)));
}
export function nextSyncEvidence(previous,result,attemptedAt,completedAt) {
  const verified=result.sourceReadComplete===true;
  return {state:result.state,attemptedAt,lastSuccessAt:verified?completedAt:previous?.lastSuccessAt||null,
    lastObservedAt:result.observedToday===true?completedAt:previous?.lastObservedAt||null,
    observedToday:result.observedToday===true,sourceReadComplete:verified,generation:result.generation};
}
