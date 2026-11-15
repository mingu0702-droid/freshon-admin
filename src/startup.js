import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

if (process.env.RENDER_SERVICE_ID === STAGE_SERVICE && process.env.RENDER_EXTERNAL_URL === STAGE_ORIGIN) {
  const [{createStageVerificationApp}, {createStageShadowRuntime}] = await Promise.all([
    import('./stageVerificationEntry.js'), import('./shadowCoverage/stageArchive.js')
  ]);
  const {env, readDirectory, configured} = createStageShadowRuntime(process.env);
  const app = createStageVerificationApp({env, readShadowDirectory:configured ? readDirectory : undefined});
  app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => {
    console.info(JSON.stringify({component:'opsmap-stage-listening',processUptimeMs:Math.round(process.uptime()*1000)}));
    app.emit('opsmap-stage-listening');
  });
} else {
  await import('./server.js');
}
