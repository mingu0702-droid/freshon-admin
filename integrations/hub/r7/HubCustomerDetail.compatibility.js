// Candidate only: replace the two exact functions in verified v64 modules.
// Do not install a duplicate global definition or change collectors/triggers.
function hubGetMapMarkerDetail(customerCode, deliveryDate) {
  const code = String(customerCode || '').trim().toUpperCase();
  if (!code) return {ok:false,error:'CUSTOMER_CODE_REQUIRED'};
  const filters = {customerCode:code,limit:1};
  if (deliveryDate) { filters.startDate=deliveryDate; filters.endDate=deliveryDate; }
  function selected(response, source) {
    if (!response || response.ok !== true) {
      return {error:source + (/timeout|timed out/i.test(String(response && response.error || '')) ? '_TIMEOUT' : '_FAILED')};
    }
    const data=response.data;
    if (!Array.isArray(data) && !(data && (Array.isArray(data.rows) || Array.isArray(data.items)))) return {error:source+'_CONTRACT'};
    const rows=hubSearchObjects_(response);
    const matches=rows.filter(function(row){return String(row && row.customerCode || '').trim().toUpperCase()===code;});
    if (rows.length && !matches.length) return {error:source+'_IDENTITY_MISMATCH'};
    if (matches.length>1) return {error:source+'_CONFLICT'};
    return {row:matches[0]||{}};
  }
  // A current Customer lookup must not depend on all-history delivery queries.
  // Dated lookups preserve the existing route-first filters and field precedence.
  let route={};
  if (deliveryDate) {
    const result=selected(getDailyRoutes(filters),'ROUTE_SOURCE');
    if (result.error) return {ok:false,error:result.error};
    route=result.row;
  }
  const result=selected(getCustomers(filters),'CUSTOMER_SOURCE');
  if (result.error) return {ok:false,error:result.error};
  const customer=result.row;
  return {ok:true,data:{customerCode:code,customerName:route.customerName||customer.customerName||'',customerAddress:route.customerAddress||customer.customerAddress||'',detailAddress:route.detailAddress||customer.detailAddress||'',accessMemo:route.accessMemo||customer.accessMemo||'',confirmedVehicle:route.confirmedVehicle||'',driverName:route.driverName||'',driverPhone:route.driverPhone||'',area:route.deliveryArea||'',center:route.center||''},error:''};
}

function hubMapHttpHandleCustomerDetail_(params) {
  hubMapHttpValidateOnlyKeys_(params, ['customerCode', 'date']);
  const customerCode = hubMapHttpCustomerCode_(params.customerCode);
  let date = '';
  if (params.date != null && params.date !== '') date = hubMapHttpDate_(params.date, 'date');
  const response = hubGetMapMarkerDetail(customerCode, date);
  hubMapHttpRequireHubOk_(response, 'customerDetail');
  const row = response.data || {};
  if (String(row.customerCode || '').trim().toUpperCase() !== customerCode) {
    hubMapHttpRaise_('INTERNAL_ERROR', 'Customer identity did not match.', 502, false);
  }
  if (!row.customerName && !row.customerAddress && !row.confirmedVehicle) {
    hubMapHttpRaise_('NOT_FOUND', 'Customer was not found.', 404, false);
  }
  return {
    data: {
      customerCode: String(row.customerCode),
      customerName: hubMapHttpNullableText_(row.customerName),
      customerAddress: hubMapHttpNullableText_(row.customerAddress),
      detailAddress: hubMapHttpNullableText_(row.detailAddress),
      accessMemo: hubMapHttpNullableText_(row.accessMemo),
      confirmedVehicle: hubMapHttpNullableText_(row.confirmedVehicle),
      driverName: hubMapHttpNullableText_(row.driverName),
      driverPhone: hubMapHttpNullableText_(row.driverPhone),
      area: hubMapHttpNullableText_(row.area),
      center: hubMapHttpNullableText_(row.center)
    },
    cached: false
  };
}
