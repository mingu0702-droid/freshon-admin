// Keep this handler in the Stage clock project, separate from the Hub publisher.
function opsmapStageFixedMasterClockTick(event) {
  let runId = null;
  try {
    const properties = PropertiesService.getScriptProperties();
    const raw = properties.getProperty('OPSMAP_STAGE_SYNC_DISPATCH_V1');
    if (!raw) return;

    const settings = JSON.parse(raw);
    if (settings?.enabled !== true) return;

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
    const version = 1;
    const origin = 'APPS_SCRIPT_TIME_TRIGGER';
    const issuedAt = time.toISOString();
    const slot = Math.floor(time.getTime() / 3600000);
    const date = Utilities.formatDate(time, 'Asia/Seoul', 'yyyy-MM-dd');
    runId = stageFixedMasterClockDigest_(JSON.stringify([version, origin, triggerId, principal, slot]));
    const signed = JSON.stringify([version, origin, triggerId, principal, issuedAt, slot, date, runId]);
    const signature = stageFixedMasterClockHex_(
      Utilities.computeHmacSha256Signature(signed, secret, Utilities.Charset.UTF_8)
    );
    const response = UrlFetchApp.fetch(
      'https://freshon-admin-stage-preview-template.onrender.com/internal/opsmap/scheduled-sync',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({version, origin, triggerId, principal, issuedAt, slot, date, runId, signature}),
        followRedirects: false,
        muteHttpExceptions: true
      }
    );
    console.log(JSON.stringify({
      component: 'opsmap-stage-fixed-master-dispatch', runId, status: response.getResponseCode(), issuedAt
    }));
  } catch (error) {
    const allowed = ['OPSMAP_SCHEDULE_TRIGGER_SCOPE', 'OPSMAP_SCHEDULE_EXECUTOR_SCOPE'];
    console.log(JSON.stringify({
      component: 'opsmap-stage-fixed-master-dispatch',
      runId,
      error: allowed.includes(error?.message) ? error.message : 'OPSMAP_SCHEDULE_DISPATCH_FAILED'
    }));
  }
}

function stageFixedMasterClockDigest_(value) {
  return stageFixedMasterClockHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
  );
}

function stageFixedMasterClockHex_(bytes) {
  return bytes.map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}
