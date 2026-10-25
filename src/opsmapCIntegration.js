import {mountOpsmapDeliveryPhotoRoutes} from './opsmapDeliveryPhotoRouter.js';
import {createCoordinateIngestion} from './opsmapCoordinateIngestion.js';
import {createDailyCoordinateAdapter} from './opsmapDailyCoordinateAdapter.js';
import {createDeliveryAdminPhotoSource} from './opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport,DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,DELIVERY_ADMIN_PHOTO_HOSTS} from './opsmapDeliveryAdminTransport.js';

// Pass this callback to the existing A mount. It shares the exact staff session
// and stays off until an explicitly configured private source is approved.
export function createOpsmapCPrivateExtension({source=null,enabled=false,...limits}={}) {
  return ({app,requireStaff,isSessionCurrent,previewEnabled}) => mountOpsmapDeliveryPhotoRoutes({
    app,requireStaff,isSessionCurrent,source,...limits,
    enabled:() => enabled === true && previewEnabled() === true
  });
}

// Connect these two data callbacks at the existing collection/read boundaries.
// Constructing a candidate never starts collection, a timer, or publication.
export function createOpsmapCCandidate({coordinates,photos}={}) {
  const ingestion=createCoordinateIngestion(coordinates);
  return {
    afterDailyCollection:result=>ingestion.afterDailyCollection(result),
    beforeMapIncremental:input=>ingestion.beforeMapIncremental(input),
    mountPrivateExtensions:createOpsmapCPrivateExtension(photos)
  };
}

// Strict Customer collection receipts are separate from business completeness.
// This path is opt-in and leaves the original C callbacks compatible.
export function createOpsmapCDailyCandidate({coordinates,photos}={}) {
  const daily=createDailyCoordinateAdapter(coordinates);
  return {
    afterCustomerDailyCollection:(result,receipt)=>daily.afterCustomerDailyCollection(result,receipt),
    projectDayEnvelope:(envelope,run)=>daily.projectDayEnvelope(envelope,run),
    mountPrivateExtensions:createOpsmapCPrivateExtension(photos)
  };
}

// Only an already authorized in-process requester is accepted. No cookie/token
// extraction or login is performed by this integration factory.
export function createOpsmapCAuthenticatedPhotoExtension({approvedRequest,hasApprovedSession,listDeliveryMetadata,
  enabled=false,transportOptions={},firstPhotoKind=null,restrictSource=source=>source,...limits}={}) {
  const transport=createDeliveryAdminPhotoTransport({...transportOptions,approvedRequest,hasApprovedSession});
  const source=restrictSource(createDeliveryAdminPhotoSource({...transport,listDeliveryMetadata,firstPhotoKind,
    categoryMap:DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,
    allowedImageHosts:transportOptions.allowedImageHosts||DELIVERY_ADMIN_PHOTO_HOSTS}));
  return createOpsmapCPrivateExtension({source,enabled,...limits});
}
