// Only location.message is an authoritative operational memo. Never combine sales/center/completeTypeText.
export function sanitizeLocationMessage(value, centerMemo = "") {
  let text = String(value ?? "").replace(/\r/g, "");
  if (centerMemo) text = text.split(String(centerMemo).replace(/\r/g, "")).join("");
  text = text.replace(/\(영업\)\s*/g, "");
  // A slash between sections is not the slash suffix in a door code.
  return text.split(/\n|[;；]+|\/(?=\s*(?:[*※•]|\(|배송위치|출입방법|보관위치|특이사항|배송요일|Claim|클레임|센터))|\/[ \t]+(?=[가-힣\[])/iu)
    .filter(line => !/(?:claim|클레임|고객\s*불만|\(센터\)|센터\s*(?:정보|요청|메모)|messageByCenter)/i.test(line))
    .filter(line => !/(?:점주|점장|대표|사장|고객)\s*(?:님\s*)?(?:전화|연락처|휴대폰)/u.test(line))
    .map(line => line.replace(/(?:점주|점장|대표|사장|고객)\s*(?:님\s*)?(?:전화|연락처|휴대폰|번호)?\s*[:：]?\s*(?:01[016789]|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}/g, "")
      .replace(/(?:01[016789]|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}/g, "")
      .replace(/^[\s*•/]+|\s+$/g, "").trim())
    .filter(Boolean).join("\n");
}
export function parseLocationMessage(value) {
  const rawMemo = sanitizeLocationMessage(value);
  const fields = {accessInfo:"",password:"",specialRemark:"",deliveryPattern:"",rawMemo:""};
  const access=[], notes=[], unknown=[], days=[];
  // Section markers are removed without consuming credential suffixes (#/*).
  const lines=rawMemo.split(/\n|(?=(?:\*\s*)?(?:배송위치|출입방법|출입정보|특이사항|배송요일|도어락\s*비밀번호|출입비번|번호키|공동현관|보안키)\s*[:：])/u);
  for (let line of lines) {
    line=line.replace(/^[*•\s]+/u,"").trim(); if(!line)continue;
    const weekday=line.match(/배송\s*요일\s*[:：]?\s*(.+)/u);
    if(weekday){days.push(weekday[1].trim());continue;}
    const key=line.match(/(?:도어락\s*비밀번호|출입문\s*도어락|출입\s*비밀번호|출입비번|비밀번호|냉장비번|비번|번호키|공동현관|보안키)\s*[:：]?\s*([A-Za-z0-9#*\/_-]{2,})/iu);
    if(key && !fields.password)fields.password=key[1];
    const entry=line.match(/^(?:배송위치|출입방법|출입정보)\s*[:：]?\s*(.*)/u);
    if(entry){
      let body=entry[1];
      const code=body.match(/^([A-Za-z0-9#*\/_-]{2,})(?=\s|$)/u);
      if(code){if(!fields.password)fields.password=code[1];body=body.slice(code[1].length).trim();}
      if(body)access.push(body);
    }else if(/^(?:특이사항|보관위치|메모|비고)\s*[:：]?|냉장|냉동|실온/u.test(line)){
      notes.push(line.replace(/^(?:특이사항|메모|비고)\s*[:：]?\s*/u,""));
    }else if(!key){unknown.push(line);}
  }
  fields.accessInfo=[...new Set(access)].join(" · ");
  fields.specialRemark=[...new Set(notes)].join(" · ");
  fields.deliveryPattern=[...new Set(days)].join(" · ");
  // Only sanitized unparsed content is exposed as an explicit fallback.
  fields.rawMemo=unknown.length?unknown.join("\n"):"";
  return fields;
}
export function locationDetailsFromTasks(rows, date) {
  const result={};
  for(const row of rows){
    const code=String(row.customer?.erpCode || row.customerErpCode || row.customerCode || "").trim().toUpperCase();
    if(!code || !row.location || typeof row.location.message!=="string")continue;
    if(result[code])continue;
    result[code]={...parseLocationMessage(sanitizeLocationMessage(row.location.message, row.location.messageByCenter)),memoSource:"location.message",memoDate:date,
      detailAddress:row.location.addressDetail || null};
  }
  return result;
}

export function existingWeekdayReference(source, code) {
  const patterns = new Set((source.vehicles || []).flatMap(vehicle => vehicle.customers || [])
    .filter(customer => String(customer.id || customer.customerCode) === code)
    .map(customer => String(customer.delivery_pattern || "").trim()).filter(Boolean));
  // Conflicting old assignments must not be presented as a known weekday.
  return patterns.size === 1 ? [...patterns][0] : "";
}
