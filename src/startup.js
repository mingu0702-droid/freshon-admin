import {createStageVerificationApp} from './stageVerificationEntry.js';
import {stageShadowRuntimeEnv} from './shadowCoverage/stageArchive.js';

const env = await stageShadowRuntimeEnv(process.env);
const app = createStageVerificationApp({env});
app.listen(Number(process.env.PORT || 10000), '0.0.0.0');
