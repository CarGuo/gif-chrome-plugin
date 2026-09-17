import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root=resolve('tests/fixtures'), folder=resolve('test-results/transports');await mkdir(folder,{recursive:true});
const cases=['hls-ts/index.m3u8','hls-fmp4/index.m3u8','dash/index.mpd','blob','full-source','full-file-source'];
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/embedded') {res.setHeader('Content-Type','text/html');res.end('<iframe src="http://localhost:'+server.address().port+'/"></iframe>');return;}
 if(path==='/') {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Media transport fixtures</title><body><script>window.seekCount=0;window.ready=(async()=>{for(const path of ${JSON.stringify(cases)}){const v=document.createElement('video');v.title=path;v.muted=true;v.controls=true;document.body.append(v);v.addEventListener('seeking',()=>window.seekCount++);if(path==='blob'){v.src=URL.createObjectURL(await(await fetch('/motion.mp4')).blob());}else{const source=document.createElement('source');const resource=path==='full-source'?'hls-fmp4/index.m3u8':path==='full-file-source'?'motion.mp4':path;source.src='/'+resource;v.append(source);await fetch('/'+resource);const media=new MediaSource();v.src=URL.createObjectURL(media);await new Promise(r=>media.addEventListener('sourceopen',r,{once:true}));const buffer=media.addSourceBuffer('video/mp4; codecs="avc1.64000c"');const data=await(await fetch('/fragmented.mp4')).arrayBuffer();await new Promise(r=>{buffer.addEventListener('updateend',r,{once:true});buffer.appendBuffer(data);});if(path.startsWith('full-')){media.duration=3.08;}else{media.endOfStream();}}await new Promise(r=>v.readyState>=2?r():v.addEventListener('loadeddata',r,{once:true}));}return true;})();</script><body></body>`);return;}
 try{const file=resolve(root,'.'+path);assert.ok(file.startsWith(root+sep));const data=await readFile(file);res.setHeader('Content-Type',({'.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.mpd':'application/dash+xml','.m4s':'video/iso.segment','.ts':'video/mp2t'})[extname(file)]||'application/octet-stream');res.setHeader('Content-Length',data.length);res.end(data);}catch{res.writeHead(404);res.end();}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const extension=resolve(folder,'extension');await cp('dist',extension,{recursive:true});const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];manifest.content_scripts=[{matches:['http://127.0.0.1/*'],js:['page-observer.js'],world:'MAIN',run_at:'document_start'}];await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,'--autoplay-policy=no-user-gesture-required']});const report=[]; context.on('console', message=>{if(message.type()==='error')console.log('BROWSER',message.text());});
try{
 const sw=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
 const page=await context.newPage();page.on('pageerror',e=>console.error('FIXTURE',e.message));await page.goto(origin);await page.evaluate(()=>window.ready);
 const tabId=await sw.evaluate(async origin=>(await chrome.tabs.query({url:origin+'/*'}))[0].id,origin);
 const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
 const rpc=(type,data={})=>panel.evaluate(async({type,data})=>{const r=await chrome.runtime.sendMessage({target:'background',type,...data});if(!r.ok)throw Error(r.error);return r.data;},{type,data});
 const sources=await rpc('scan',{tabId});assert.equal(sources.length,6);assert.equal(sources.find(s=>s.title==='blob').blobKind,'file');
 for(const source of sources){
  if(source.title!=='blob')assert.equal(source.resources.length,1);
  const full=source.title.startsWith('full-'); let jobId;
  if(source.title==='full-file-source'){
   // v0.1.8: drive the real default-selection UI on an MSE player with a different file duration.
   const oldIds=(await rpc('list')).map(job=>job.id);
   await panel.locator('.source').filter({hasText:source.title}).click();
   await panel.getByRole('spinbutton',{name:/Speed/}).fill('2');
   await panel.getByRole('spinbutton',{name:/Longest side/}).fill('320');
   assert.equal(Number(await panel.locator('.clip-inputs input').nth(1).inputValue()),3.08);
   await panel.getByRole('button',{name:'Make GIF',exact:true}).click();
   await panel.waitForFunction(ids=>[...document.querySelectorAll('[data-job-id]')].some(el=>!ids.includes(el.getAttribute('data-job-id'))),oldIds);
   jobId=(await rpc('list')).find(job=>!oldIds.includes(job.id)).id;
  }else{[jobId]=await rpc('enqueue',{items:[{source,settings:{maxBytes:4000000,maxSide:320,fps:10,speed:2},segment:full?{id:'transport',start:0,end:source.duration,endMode:'source'}:{id:'transport',start:0.5,end:2.5}}]});}
  let job;for(let i=0;i<180;i++){job=(await rpc('list')).find(j=>j.id===jobId);if(['completed','failed','cancelled'].includes(job.stage))break;await new Promise(r=>setTimeout(r,500));}
  report.push({source:source.title,pageDuration:source.duration,fileDuration:job.source.duration,segment:job.segment,stage:job.stage,error:job.error,result:job.result,metrics:job.metrics});
  assert.equal(job.stage,'completed',JSON.stringify(report.at(-1)));assert.equal(Math.round(job.result.duration*100),full?150:100);assert.equal(await page.evaluate(()=>window.seekCount),0);
  if(full){
   assert.equal(source.duration,3.08);assert.equal(job.source.duration,3);assert.equal(job.segment.end,3);assert.equal(job.segment.endMode,'source');
  }else{assert.equal(job.segment.start,0.5);assert.equal(job.segment.end,2.5);assert.equal(job.segment.endMode,'time');}
  const url=await panel.evaluate(async id=>(await chrome.runtime.sendMessage({target:'offscreen',type:'result-url',id})).data,jobId);
  const bytes=await panel.evaluate(async url=>Array.from(new Uint8Array(await(await fetch(url)).arrayBuffer())),url);
  await writeFile(resolve(folder,source.title.replaceAll('/','-')+'.gif'),Buffer.from(bytes));console.log('PASS',source.title,job.result.bytes,'bytes, no page seeking');
 }
 await page.goto(origin+'/embedded',{waitUntil:'domcontentloaded'}); const embedded = await rpc('scan',{tabId}); assert.equal(embedded.length,0); const stored=await sw.evaluate(()=>chrome.storage.session.get('missingFrameOrigins')); assert.deepEqual(stored.missingFrameOrigins,[`http://localhost:${server.address().port}/*`]); console.log('PASS ungranted cross-origin iframe is discovered without discarding the parent scan');
}finally{await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));await context.close();server.close();}
