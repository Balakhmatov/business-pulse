/* Excel (.xlsx) reader for the Business Pulse CSV-compatible import flow.
   Library is loaded on demand; workbook contents remain in the browser. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BP_ExcelAdapter=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  const MAX_ROWS=150000;
  const LIBRARY_URLS=[
    'https://cdn.jsdelivr.net/npm/read-excel-file@6.0.0/bundle/read-excel-file.min.js',
    'https://unpkg.com/read-excel-file@6.0.0/bundle/read-excel-file.min.js'
  ];
  let libraryPromise=null;
  // Some XLSX exports contain explicit blank XML cells or sparse footer rows
  // that read-excel-file cannot decode. Load a separate parser only on failure.
  const FALLBACK_URLS=[
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
  ];
  let fallbackLibraryPromise=null;
  const fallbackBooks=new WeakMap();
  function text(value){
    if(value==null)return '';
    if(value instanceof Date){
      if(Number.isNaN(value.getTime()))return '';
      // read-excel-file returns date-only Excel cells as UTC Date objects.
      return value.toISOString().slice(0,10);
    }
    if(typeof value==='boolean')return value?'TRUE':'FALSE';
    return String(value).trim();
  }
  function table(matrix,name){
    if(!Array.isArray(matrix))throw Error('Не удалось прочитать лист Excel.');
    if(matrix.length>MAX_ROWS+1)throw Error('Слишком большой лист Excel: более 150 000 строк.');
    const physicalRows=matrix.map(row=>Array.isArray(row)?row.map(text):[]);
    const data=physicalRows.filter(row=>row.some(cell=>cell.trim()));
    if(data.length<2)throw Error('На выбранном листе нет строк с данными.');
    const width=Math.max(...data.slice(0,100).map(row=>row.length));
    if(width<2)throw Error('На выбранном листе меньше двух столбцов.');
    if(width>300)throw Error('В Excel слишком много столбцов (максимум 300).');
    if(root.BP_SmartImport?.detect)return root.BP_SmartImport.detect(physicalRows,name);
    // Node/tests without a browser can still use the legacy table adapter.
    return {
      name,
      head:data[0].map(x=>x.trim()),
      rows:data.slice(1).map(row=>Array.from({length:width},(_,i)=>row[i]||''))
    };
  }
  function addScript(url,ready){
    return new Promise((resolve,reject)=>{
      const script=root.document.createElement('script');
      script.src=url;
      script.async=true;
      script.onload=()=>ready()?resolve():reject(Error('Библиотека Excel недоступна.'));
      script.onerror=()=>reject(Error('Не удалось загрузить библиотеку Excel.'));
      root.document.head.appendChild(script);
    });
  }
  function ensureLibrary(){
    if(typeof root.readXlsxFile==='function')return Promise.resolve(root.readXlsxFile);
    if(!libraryPromise){
      libraryPromise=(async()=>{
        for(const url of LIBRARY_URLS){
          try{await addScript(url,()=>typeof root.readXlsxFile==='function');return root.readXlsxFile;}catch{}
        }
        throw Error('Не удалось загрузить модуль Excel. Проверьте интернет-соединение и попробуйте снова.');
      })().catch(error=>{libraryPromise=null;throw error;});
    }
    return libraryPromise;
  }
  async function ensureFallbackLibrary(){
    if(typeof root.ExcelJS?.Workbook==='function')return root.ExcelJS;
    if(!fallbackLibraryPromise){
      fallbackLibraryPromise=(async()=>{
        for(const url of FALLBACK_URLS){
          try{
            await addScript(url,()=>typeof root.ExcelJS?.Workbook==='function');
            return root.ExcelJS;
          }catch{}
        }
        throw Error('Не удалось прочитать Excel: оба модуля недоступны. Повторите загрузку при стабильном соединении.');
      })().catch(error=>{fallbackLibraryPromise=null;throw error;});
    }
    return fallbackLibraryPromise;
  }
  async function fallbackWorkbook(file){
    if(!fallbackBooks.has(file)){
      const loading=(async()=>{
        const ExcelJS=await ensureFallbackLibrary();
        const book=new ExcelJS.Workbook();
        await book.xlsx.load(await file.arrayBuffer());
        return book;
      })();
      fallbackBooks.set(file,loading);
      loading.catch(()=>{fallbackBooks.delete(file);});
    }
    return fallbackBooks.get(file);
  }
  function readCell(cell){
    const value=cell?.value;
    if(value==null)return null;
    if(typeof value==='object'&&!(value instanceof Date)){
      if(Array.isArray(value.richText))return value.richText.map(x=>x.text||'').join('');
      if(value.result!==undefined)return value.result;
      if(typeof value.text==='string')return value.text;
      if(value.formula||value.sharedFormula||value.error)return null;
    }
    return value;
  }
  function fallbackMatrix(book,name){
    const sheet=book.worksheets.find(x=>x.name===name);
    if(!sheet)throw Error('Такого листа нет в файле.');
    const height=sheet.rowCount||0,width=sheet.columnCount||0;
    if(height>MAX_ROWS+1||width>300)throw Error('Лист Excel слишком большой. Максимум 150 000 строк и 300 столбцов.');
    const matrix=[];
    for(let i=1;i<=height;i++){
      const row=sheet.getRow(i),line=[];
      for(let j=1;j<=width;j++)line.push(readCell(row.getCell(j)));
      matrix.push(line);
    }
    return matrix;
  }
  async function workbook(file){
    let read=null,sheets;
    try{
      read=await ensureLibrary();
      sheets=await read(file,{getSheets:true});
    }catch(primaryError){
      // A broken workbook may be readable by ExcelJS. Do not discard user data.
      const fallback=await fallbackWorkbook(file);
      sheets=fallback.worksheets.map(x=>({name:x.name}));
    }
    if(!Array.isArray(sheets)||!sheets.length||!sheets.every(x=>x&&typeof x.name==='string')){
      throw Error('Не удалось определить листы Excel. Пересохраните файл в формате .xlsx.');
    }
    const names=sheets.map(x=>x.name);
    return {
      names,
      async readSheet(name){
        if(!names.includes(name))throw Error('Такого листа нет в файле.');
        let matrix;
        if(read){
          try{
            matrix=await read(file,{sheet:name,trim:false});
          }catch(error){
            const fallback=await fallbackWorkbook(file);
            matrix=fallbackMatrix(fallback,name);
          }
        }else{
          const fallback=await fallbackWorkbook(file);
          matrix=fallbackMatrix(fallback,name);
        }
        return table(matrix,file.name);
      }
    };
  }
  return {text,table,workbook};
});
