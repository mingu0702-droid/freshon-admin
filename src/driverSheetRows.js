// Existing driver sheet has a title then four active horizontal contact blocks.
// A:S excludes the distinct U:X scheduled-termination section by contract.
const text = value => String(value ?? '').normalize('NFKC').replace(/\r/g, '').trim();
const header = value => text(value).replace(/\s+/g, '');
const fail = () => Object.assign(Error('DRIVER_SHEET_HEADER_UNRECOGNIZED'), { code: 'DRIVER_SHEET_HEADER_UNRECOGNIZED' });
const fields = ['호차', '기사명', '연락처', '운수사'];
const blockStarts = [0, 5, 10, 15];
const aliases = {
  호차: ['호차','차량','차량번호','운행호차','기준호차'],
  기사명: ['기사명','기사이름','배송기사명','담당기사','성명','기사'],
  연락처: ['전화번호','연락처','기사연락처','배송기사휴대전화번호','휴대폰','핸드폰'],
  운수사: ['운수사','운수사명','운수회사','업체','운송사','소속','협력사'],
  톤수: ['톤수','차량톤수','톤'],
  적용일: ['적용일','적용일자','변경일','변경일자','시작일','시작일자','기준일']
};

export function parseDriverSheetValues(values) {
  if (!Array.isArray(values) || values.some(row => !Array.isArray(row))) throw fail();
  const title = header(values[0]?.[0]);
  let headerIndex, blocks, layout, flatIndexes = null;
  if (title === 'SFN기사연락처') {
    headerIndex = 1; blocks = blockStarts; layout = 'ACTIVE_HORIZONTAL_BLOCKS';
    if (!blocks.every(start => fields.every((field, offset) => header(values[1]?.[start + offset]) === field))) throw fail();
  } else {
    // Preserve the previously supported conventional single header-row shape.
    const columns = (values[0] || []).slice(0, 19).map(header);
    flatIndexes = Object.fromEntries(Object.entries(aliases).map(([field,names])=>[field,columns.findIndex(value=>names.includes(value))]));
    if (!fields.slice(0, 3).every(field => flatIndexes[field] >= 0)
        || columns.filter(value=>aliases.호차.includes(value)).length !== 1) throw fail();
    headerIndex = 0; blocks = [0]; layout = 'SINGLE_CONTACT_TABLE';
  }
  const rows = []; let unassigned = 0, repeatedHeaderRows = 0;
  for (let sourceIndex = headerIndex + 1; sourceIndex < values.length; sourceIndex++) {
    const source = values[sourceIndex];
    for (const start of blocks) {
      const cells = fields.map((field, offset) => text(source[flatIndexes ? flatIndexes[field] : start + offset]));
      if (!cells.some(Boolean)) continue;
      if (fields.every((field, offset) => header(cells[offset]) === field)) { repeatedHeaderRows++; continue; }
      if (!cells[0]) { unassigned++; continue; }
      const row = Object.fromEntries(fields.map((field, offset) => [field, cells[offset]]));
      if (flatIndexes) for (const field of ['톤수','적용일']) if (flatIndexes[field] >= 0) row[field] = text(source[flatIndexes[field]]);
      row._sourceRow = sourceIndex + 1; row._sourceColumn = start + 1;
      row._savedOrder = rows.length + 1; rows.push(row);
    }
  }
  return { columns: [...fields], rows,
    meta: { layout, headerRow: headerIndex + 1, activeBlocks: blocks.length,
      activeColumnRanges: blocks.map(start => ({ from: start + 1, to: start + 4 })),
      sourceRange: 'A1:S1001', excludedTerminationSection: true,
      effectiveDateAvailable: !!flatIndexes && flatIndexes.적용일 >= 0, skippedUnassignedRecords: unassigned, skippedRepeatedHeaders: repeatedHeaderRows } };
}
