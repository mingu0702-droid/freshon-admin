// Keep this handler in the Stage clock project, separate from the Hub publisher.
const OPSMAP_STAGE_HOURLY_PROFILE = 'STAGE_HOURLY_WMS_V1';
const OPSMAP_STAGE_CLOCK_ENDPOINT = 'https://freshon-admin-stage-preview-template.onrender.com/internal/opsmap/scheduled-sync';
function opsmapStageFixedMasterClockTick(event) {
  let runId = null, lock = null;
  try {
    const properties = PropertiesService.getScriptProperties();
    const raw = properties.getProperty('OPSMAP_STAGE_SYNC_DISPATCH_V1');
    if (!raw) return;

    const settings = JSON.parse(raw);
    if (settings?.enabled !== true) return;
    if (settings.profile !== undefined && settings.profile !== OPSMAP_STAGE_HOURLY_PROFILE) {
      throw Error('OPSMAP_SCHEDULE_PROFILE_SCOPE');
    }
    const hourly = settings.profile === OPSMAP_STAGE_HOURLY_PROFILE;

    const triggerId = String(event?.triggerUid ?? '');
    const secret = properties.getProperty('OPSMAP_STAGE_SYNC_SCHEDULER_SECRET');
    if (!/^\d{1,30}$/.test(triggerId) || settings.triggerId !== triggerId ||
        typeof secret !== 'string' || secret.length < 32 || secret.length > 512) {
      throw Error('OPSMAP_SCHEDULE_TRIGGER_SCOPE');
    }

    const triggers = ScriptApp.getProjectTriggers().filter(
      trigger => trigger.getHandlerFunction() === 'opsmapStageFixedMasterClockTick'
    );
    if (triggers.length !== 1 || triggers[0].getUniqueId() !== triggerId ||
        triggers[0].getTriggerSource() !== ScriptApp.TriggerSource.CLOCK) {
      throw Error('OPSMAP_SCHEDULE_TRIGGER_SCOPE');
    }

    const account = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    const principal = account && stageFixedMasterClockDigest_(account);
    if (!principal || principal !== settings.executorHash) {
      throw Error('OPSMAP_SCHEDULE_EXECUTOR_SCOPE');
    }

    // Match the receipt consumed by verifyOpsmapScheduleReceipt.
    const time = new Date();
    const issuedAt = time.toISOString();
    const slot = Math.floor(time.getTime() / 3600000);
    const hour = (slot + 9) % 24;
    if (hourly && hour !== 6 && hour !== 20 && hour !== 21) return;
    const night = hourly && (hour === 20 || hour === 21);
    const origin = night ? 'APPS_SCRIPT_TIME_TRIGGER_WMS_NIGHT' : 'APPS_SCRIPT_TIME_TRIGGER';
    const version = 1;
    const acknowledgment = 'OPSMAP_STAGE_CLOCK_ACK_' + (night ? 'WMS_NIGHT' : 'DAILY');
    if (hourly) {
      const candidate = LockService.getScriptLock();
      if (!candidate.tryLock(1000)) return;
      lock = candidate;
      if (properties.getProperty(acknowledgment) === String(slot)) return;
    }
    const date = Utilities.formatDate(time, 'Asia/Seoul', 'yyyy-MM-dd');
    runId = stageFixedMasterClockDigest_(JSON.stringify([version, origin, triggerId, principal, slot]));
    const signed = JSON.stringify([version, origin, triggerId, principal, issuedAt, slot, date, runId]);
    const signature = stageFixedMasterClockHex_(
      Utilities.computeHmacSha256Signature(signed, secret, Utilities.Charset.UTF_8)
    );
    const response = UrlFetchApp.fetch(
      OPSMAP_STAGE_CLOCK_ENDPOINT + (night ? '/wms-night' : ''),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({version, origin, triggerId, principal, issuedAt, slot, date, runId, signature}),
        followRedirects: false,
        muteHttpExceptions: true
      }
    );
    const status = response.getResponseCode();
    if (hourly && status === 202) properties.setProperty(acknowledgment, String(slot));
    console.log(JSON.stringify({
      component: 'opsmap-stage-fixed-master-dispatch', runId, status, issuedAt,
      ...(hourly ? {purpose: night ? 'WMS_NIGHT' : 'DAILY'} : {})
    }));
  } catch (error) {
    const allowed = ['OPSMAP_SCHEDULE_TRIGGER_SCOPE', 'OPSMAP_SCHEDULE_EXECUTOR_SCOPE', 'OPSMAP_SCHEDULE_PROFILE_SCOPE'];
    console.log(JSON.stringify({
      component: 'opsmap-stage-fixed-master-dispatch',
      runId,
      error: allowed.includes(error?.message) ? error.message : 'OPSMAP_SCHEDULE_DISPATCH_FAILED'
    }));
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Run in the Stage clock editor as the approved owner. Never modifies triggers.
function opsmapStageClockStatus() {
  const properties = PropertiesService.getScriptProperties();
  let settings = {};
  try { settings = JSON.parse(properties.getProperty('OPSMAP_STAGE_SYNC_DISPATCH_V1') || '{}') || {}; }
  catch { /* Report invalid scope below without dumping the property. */ }
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === 'opsmapStageFixedMasterClockTick'
  );
  const singleClock = triggers.length === 1 && triggers[0].getTriggerSource() === ScriptApp.TriggerSource.CLOCK;
  const account = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const key = properties.getProperty('OPSMAP_STAGE_SYNC_SCHEDULER_SECRET');
  const status = {
    enabled: settings.enabled === true,
    profile: settings.profile === undefined ? 'LEGACY' :
      settings.profile === OPSMAP_STAGE_HOURLY_PROFILE ? OPSMAP_STAGE_HOURLY_PROFILE : 'INVALID',
    triggerCount: triggers.length,
    clockTriggerId: singleClock ? triggers[0].getUniqueId() : null,
    triggerMatched: singleClock && triggers[0].getUniqueId() === settings.triggerId,
    executorMatched: Boolean(account && stageFixedMasterClockDigest_(account) === settings.executorHash),
    secretConfigured: typeof key === 'string' && key.length >= 32 && key.length <= 512
  };
  console.log(JSON.stringify(status));
  return status;
}

function stageFixedMasterClockDigest_(value) {
  return stageFixedMasterClockHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
  );
}

function stageFixedMasterClockHex_(bytes) {
  return bytes.map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}
