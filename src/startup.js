import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

if (process.env.RENDER_SERVICE_ID === STAGE_SERVICE && process.env.RENDER_EXTERNAL_URL === STAGE_ORIGIN) {
  const [{createStageVerificationApp,createStageSyncReaders}, {createStageShadowRuntime}, {createStageWmsDispatchExportReader}] = await Promise.all([
    import('./stageVerificationEntry.js'), import('./shadowCoverage/stageArchive.js'), import('./opsmapWmsDispatchExport.js')
  ]);
  const {env, readDirectory, configured} = createStageShadowRuntime(process.env);
  // Keep the archive reader credential out of the general app environment.
  const syncReaders = createStageSyncReaders({env:process.env});
  const readWmsExport = createStageWmsDispatchExportReader({env:process.env});
  console.info(JSON.stringify({component:'stage-wms-export-config', ...readWmsExport.configuration}));
  const app = createStageVerificationApp({env,syncReaders,readWmsExport,readShadowDirectory:configured ? readDirectory : undefined});
  app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => {
    console.info(JSON.stringify({component:'opsmap-stage-listening',processUptimeMs:Math.round(process.uptime()*1000)}));
    app.emit('opsmap-stage-listening');
  });
} else {
  await import('./server.js');
}
