// Publication is not proof that every required source was read successfully.
export const SYNC_CENTERS = Object.freeze(['osan','yeongnam','honam']);
export function completeSyncObservation(day, requiredCenters = SYNC_CENTERS) {
  if (!day || day.proof !== 'VERIFIED_COMPLETE_DAY' || !Array.isArray(requiredCenters) || !requiredCenters.length ||
      requiredCenters.some(c => !SYNC_CENTERS.includes(c)) || new Set(requiredCenters).size !== requiredCenters.length ||
      !Array.isArray(day.completeCenters) || new Set(day.completeCenters).size !== day.completeCenters.length ||
      day.unidentified !== 0 || !Number.isSafeInteger(day.sourceRows) || day.sourceRows < 0 ||
      !Array.isArray(day.tasks) || day.tasks.length !== day.sourceRows) return false;
  return requiredCenters.every(c => day.completeCenters.includes(c));
}
export function nextSyncEvidence(previous,result,attemptedAt,completedAt) {
  const verified=result.sourceReadComplete===true;
  return {state:result.state,attemptedAt,lastSuccessAt:verified?completedAt:previous?.lastSuccessAt||null,
    lastObservedAt:result.observedToday===true?completedAt:previous?.lastObservedAt||null,
    observedToday:result.observedToday===true,sourceReadComplete:verified,generation:result.generation};
}
