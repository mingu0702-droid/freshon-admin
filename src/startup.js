import {createStageVerificationApp} from './stageVerificationEntry.js';
import {createStageShadowRuntime} from './shadowCoverage/stageArchive.js';

const {env, readDirectory} = createStageShadowRuntime(process.env);
const app = createStageVerificationApp({env, readShadowDirectory: readDirectory});
app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => void readDirectory());
