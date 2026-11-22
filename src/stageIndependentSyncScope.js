import {checkStageVerifiedBaseline, createOpsmapDurableGeneration, stageOpsmapDurableStorage,
  stageVerifiedBaselineConfig} from './opsmapDurableGeneration.js';
import {stageFixedMasterScope} from './stageFixedMasterSync.js';
import {createStageNationalRegistryReader, createStageNationalRegistryStorage,
  stageNationalRegistryScope} from './stageNationalRegistry.js';
import {createStageStaffRegistryAsset} from './stageStaffRegistryAsset.js';

export async function readIndependentStageScopes(env) {
  const baseline=stageVerifiedBaselineConfig(env,env.OPSMAP_STAGE_INDEPENDENT_BASELINE_JSON);
  const staff=createStageStaffRegistryAsset({env});
  const national=createStageNationalRegistryReader({store:createStageNationalRegistryStorage({env})});
  if (!baseline || !staff) throw Error('FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE');
  const durable=createOpsmapDurableGeneration({
    ...stageOpsmapDurableStorage({env,baselineKey:baseline.baselineKey}),readOnlyView:true,retainCoverageFiles:false
  });
  try {
    const generation=checkStageVerifiedBaseline(await durable.readBaseline(baseline.ref));
    const [additional,published]=await Promise.all([staff.read(),national.read()]);
    if (!published) throw Error('FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE');
    const active={
      registry:generation.registry,ledger:generation.ledger,generation:generation.index.sha256,
      expiresAt:Infinity,counts:{registered:generation.registry.size}
    };
    const fixedScope=stageFixedMasterScope(active,additional,published);
    if (!fixedScope) throw Error('FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE');
    return {fixedScope,registryScope:stageNationalRegistryScope(active)};
  } finally {
    await durable.dispose();
  }
}
