// FreshOn fixedAlctnList keys only. Do not use this contract for general
// Customer, snapshot, protected-detail, or HTTP customer-code validation.
export function isFixedMasterCustomerKey(value) {
  return typeof value==='string' && value.length>=1 && value.length<=64 && value.trim()===value
    && /^(?:[A-Z]\d+|\d+)$/.test(value);
}
export function normalizeFixedMasterCustomerKey(value) {
  if(typeof value!=='string')return '';
  const code=value.trim().toUpperCase();
  return isFixedMasterCustomerKey(code)?code:'';
}
