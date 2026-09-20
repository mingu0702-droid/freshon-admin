// Public error vocabulary only: never expose upstream bodies or arbitrary messages.
export function mapReadFailure(error, kind = 'HISTORY') {
  const code = String(error?.message || '').replace(/^HUB_/, '');
  if (code === 'OUTPUT_HTML_404') return { status: 502, code: 'SOURCE_OUTPUT_HTML_404', retryable: false };
  if (error?.name === 'AbortError' || /^(PERIOD|HISTORY|ROUTE)_UPSTREAM_TIMEOUT$/.test(code)) return { status: 504, code: kind + '_UPSTREAM_TIMEOUT', retryable: true };
  if (['PERIOD_SOURCE_CHANGED','HISTORY_SOURCE_CHANGED','HISTORY_LOCATOR_CHANGED'].includes(code)) return { status: 409, code, retryable: true };
  if (['PERIOD_ROW_INVALID','PERIOD_HEADER_INVALID','HISTORY_DATE_INVALID','HISTORY_HEADER_INVALID'].includes(code)) return { status: 422, code, retryable: false };
  if (/^(PERIOD_(PAGE|SOURCE|HISTORY)|HISTORY(?:_(BATCH|SOURCE))?)_INCOMPLETE$/.test(code)) return { status: 409, code, retryable: true };
  if (['CIRCUIT_OPEN','CIRCUIT_HALF_OPEN','SOURCE_BUSY'].includes(code)) return { status: 503, code: 'SOURCE_BUSY', retryable: true };
  if (code === 'SOURCE_AUTH_REQUIRED' || ['auth'].includes(error?.failureType) || [401,403].includes(Number(error?.upstreamStatus))) return { status: 503, code: 'SOURCE_AUTH_REQUIRED', retryable: false };
  if (error?.failureType === 'parse') return { status: 502, code: 'SOURCE_INVALID_JSON', retryable: true };
  return { status: 502, code: kind + '_SOURCE_UNAVAILABLE', retryable: true };
}
