// Choose the existing Stage safety entry only for its exact service origin.
// No feature, writer, collector, or secret is enabled by this dispatcher.
const stage='https://freshon-admin-stage-preview-template.onrender.com';
if(process.env.OPSMAP_STAGE_VERIFY_ONLY==='1'||process.env.RENDER_EXTERNAL_URL===stage){
  await import('./stageVerificationEntry.js');
}else{
  await import('./server.js');
}
