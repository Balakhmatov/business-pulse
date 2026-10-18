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
  function addScript(url){
    return new Promise((resolve,reject)=>{
      const script=root.document.createElement('script');
      script.src=url;
      script.async=true;
      script.onload=()=>typeof root.readXlsxFile==='function'?resolve():reject(Error('Библиотека Excel недоступна.'));
      script.onerror=()=>reject(Error('Не удалось загрузить библиотеку Excel.'));
      root.document.head.appendChild(script);
    });
  }
  function ensureLibrary(){
    if(typeof root.readXlsxFile==='function')return Promise.resolve(root.readXlsxFile);
    if(!libraryPromise){
      libraryPromise=(async()=>{
        for(const url of LIBRARY_URLS){
          try{await addScript(url);return root.readXlsxFile;}catch{}
        }
        throw Error('Не удалось загрузить модуль Excel. Проверьте интернет-соединение и попробуйте снова.');
      })().catch(error=>{libraryPromise=null;throw error;});
    }
    return libraryPromise;
  }
  async function workbook(file){
    const read=await ensureLibrary();
    const sheets=await read(file,{getSheets:true});
    if(!Array.isArray(sheets)||!sheets.length||!sheets.every(x=>x&&typeof x.name==='string')){
      throw Error('Не удалось определить листы Excel. Пересохраните файл в формате .xlsx.');
    }
    const names=sheets.map(x=>x.name);
    return {
      names,
      async readSheet(name){
        if(!names.includes(name))throw Error('Такого листа нет в файле.');
        const matrix=await read(file,{sheet:name});
        return table(matrix,file.name);
      }
    };
  }
  return {text,table,workbook};
});
