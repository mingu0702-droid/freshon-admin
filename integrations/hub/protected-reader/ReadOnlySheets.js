// SpreadsheetApp.openById requires a write-capable OAuth scope. Use Sheets reads
// with spreadsheets.readonly, retaining the existing exact-row locator contract.
var protectedReaderSheetTitles_={};
function protectedReaderReadOnlyBook_(id){
  const metadata=Sheets.Spreadsheets.get(id,{fields:'sheets.properties'}),headers={},localReads={};
  (metadata.sheets||[]).forEach(function(s){protectedReaderSheetTitles_[id+':'+s.properties.sheetId]=s.properties.title;});
  function column(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
  const book={getId:function(){return id;},getSheetByName:function(name){
    const item=(metadata.sheets||[]).filter(function(s){return s.properties.title===name;})[0];if(!item)return null;
    const props=item.properties;
    const sheet={getParent:function(){return book;},getSheetId:function(){return props.sheetId;},getLastRow:function(){return props.gridProperties.rowCount;},getLastColumn:function(){return props.gridProperties.columnCount;},getRange:function(row,col,count,width){
      if(!Number.isInteger(row)||!Number.isInteger(col)||!Number.isInteger(count)||!Number.isInteger(width)||row<1||col<1||count<1||width<1||width>128||count*width>300000)throw Error('READ_RANGE_INVALID');
      if(count>1&&(width!==1||!headers[name]||headers[name][col-1]!=='customerCode'))throw Error('BULK_PRIVATE_READ_FORBIDDEN');
      const a1="'"+name.replace(/'/g,"''")+"'!"+column(col)+row+':'+column(col+width-1)+(row+count-1);
      function values(){
        let source=localReads[a1];if(!source){const started=Date.now(),response=Sheets.Spreadsheets.Values.get(id,a1,{valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});source=response.values||[];localReads[a1]=source;
          if(protectedReaderProfile_){protectedReaderProfile_.sheetsReadMs=(protectedReaderProfile_.sheetsReadMs||0)+Date.now()-started;protectedReaderProfile_.sheetsReadCalls=(protectedReaderProfile_.sheetsReadCalls||0)+1;}}
        const rows=Array.from({length:count},function(_,offset){return Array.from({length:width},function(_,c){let value=source[offset]&&source[offset][c];if(value==null)value='';const header=headers[name]&&headers[name][col+c-1];if(row>1&&typeof value==='number'&&['deliveryDate','updatedAt','createdAt'].indexOf(header)>=0)value=new Date(Date.UTC(1899,11,30)+Math.round(value*86400000)-9*3600000);return value;});});
        if(row===1&&col===1&&count===1)headers[name]=rows[0];return rows;
      }
      return {getValues:values,createTextFinder:function(code){
        if(width!==1||!headers[name]||headers[name][col-1]!=='customerCode')throw Error('CODE_LOCATOR_ONLY');
        const finder={matchEntireCell:function(yes){if(yes!==true)throw Error('EXACT_CODE_REQUIRED');return finder;},useRegularExpression:function(yes){if(yes!==false)throw Error('REGEX_CODE_FORBIDDEN');return finder;},findAll:function(){return values().map(function(r,i){return String(r[0]||'')===code?{getRow:function(){return row+i;}}:null;}).filter(Boolean);}};return finder;
      }};
    }};return sheet;
  }};return book;
}
function protectedReaderBatchKeys_(id,sheetId,filters){
  const title=protectedReaderSheetTitles_[id+':'+sheetId];if(!title||!filters.length||filters.length>200)throw Error('HISTORY_RANGE_CONTRACT');
  function col(n){let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
  function signature(g){return [g.sheetId||0,g.startRowIndex||0,g.endRowIndex,g.startColumnIndex||0,g.endColumnIndex].join(':');}
  function a1(g){if(g.sheetId!==sheetId||g.endRowIndex!==g.startRowIndex+1||g.startColumnIndex<0||g.endColumnIndex<=g.startColumnIndex||g.endColumnIndex-g.startColumnIndex>2)throw Error('HISTORY_RANGE_CONTRACT');return "'"+title.replace(/'/g,"''")+"'!"+col(g.startColumnIndex)+(g.startRowIndex+1)+':'+col(g.endColumnIndex-1)+g.endRowIndex;}
  function rangeSignature(range){
    const bang=String(range||'').lastIndexOf('!');if(bang<0)throw Error('HISTORY_RANGE_IDENTITY');let sheet=range.slice(0,bang);if(sheet[0]==="'"&&sheet.slice(-1)==="'")sheet=sheet.slice(1,-1).replace(/''/g,"'");if(sheet!==title)throw Error('HISTORY_RANGE_IDENTITY');
    const m=range.slice(bang+1).replace(/\$/g,'').match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);if(!m)throw Error('HISTORY_RANGE_IDENTITY');
    function index(s){return s.split('').reduce(function(n,c){return n*26+c.charCodeAt(0)-64;},0)-1;}
    return signature({sheetId:sheetId,startRowIndex:Number(m[2])-1,endRowIndex:Number(m[4]||m[2]),startColumnIndex:index(m[1]),endColumnIndex:index(m[3]||m[1])+1});
  }
  const expected=new Map(filters.map(function(f){return [signature(f.gridRange),f];}));if(expected.size!==filters.length)throw Error('HISTORY_RANGE_DUPLICATE');
  const response=Sheets.Spreadsheets.Values.batchGet(id,{ranges:filters.map(function(f){return a1(f.gridRange);}),majorDimension:'ROWS',valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});
  if(!response||!Array.isArray(response.valueRanges)||response.valueRanges.length!==filters.length)throw Error('HISTORY_BATCH_INCOMPLETE');
  const seen=new Set();return {valueRanges:response.valueRanges.map(function(r){const key=rangeSignature(r.range),filter=expected.get(key);if(!filter||seen.has(key))throw Error('HISTORY_RANGE_IDENTITY');seen.add(key);return {dataFilters:[filter],valueRange:r};})};
}
