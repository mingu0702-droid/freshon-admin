import {createStageVerificationApp} from './stageVerificationEntry.js';

const app = createStageVerificationApp();
app.listen(Number(process.env.PORT || 10000), '0.0.0.0');
