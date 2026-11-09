import {STAGE_ORIGIN, STAGE_SERVICE} from './stageAbValidation.js';

if (process.env.RENDER_SERVICE_ID === STAGE_SERVICE && process.env.RENDER_EXTERNAL_URL === STAGE_ORIGIN) {
  const [{createStageVerificationApp}, {createStageShadowRuntime}] = await Promise.all([
    import('./stageVerificationEntry.js'), import('./shadowCoverage/stageArchive.js')
  ]);
  const {env, readDirectory} = createStageShadowRuntime(process.env);
  const app = createStageVerificationApp({env, readShadowDirectory:readDirectory});
  app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => void readDirectory());
} else {
  await import('./server.js');
}
