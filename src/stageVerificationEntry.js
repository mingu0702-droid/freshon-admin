// Stage-only entry: never depend on an optional environment flag for safety.
const stageOrigin='https://freshon-admin-stage-preview-template.onrender.com';
if(process.env.RENDER_EXTERNAL_URL!==stageOrigin)throw Error('EXACT_STAGE_ORIGIN_REQUIRED');
process.env.OPSMAP_STAGE_VERIFY_ONLY='1';
process.env.MAP_PHASE2B_PREVIEW_ENABLED='true';
process.env.MAP_PHASE2B_PREVIEW_ENV='stage';
// Delivery Admin source authentication is separate and is not acquired here.
process.env.OPSMAP_APPROVED_PHOTO_VERIFY=process.env.OPSMAP_APPROVED_PHOTO_VERIFY==='1'?'1':'0';
await import('./server.js');
