import{i as m,g as w,v as y,w as v,x as $,k as _,y as x,c as f,u as I}from"./uploader-Ch1V5AtJ.js";const P=document.getElementById("mount");function d(s){P.innerHTML=`<h2>Data Recovery</h2>${s}`}function r(s){return String(s).replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e])}async function S(){let s;try{s=(await m()).kind}catch{d(`
      <p class="error">Could not open browser storage. This can happen if you
      cleared your browser data or are using a different browser than the one
      you used for the experiment.</p>
    `);return}if(s==="memory"){d(`
      <p class="error">No persistent storage found. IndexedDB is unavailable in
      this browser. Please use the same browser you used for the experiment
      (Chrome, Firefox, or Edge on a desktop computer).</p>
    `);return}const e=await w();if(!e||e.length===0){d(`
      <p class="warn">No session data found in this browser. This can happen if:</p>
      <ul>
        <li>You cleared your browser data since the experiment</li>
        <li>You are using a different browser or device</li>
        <li>You are in a private/incognito window</li>
      </ul>
      <p>If you have the downloaded JSON file, please send it to the
      researcher through Prolific messaging.</p>
    `);return}const l=await y(),n=await v(),o=await $(),t=await _(),u=x(e).filter(a=>a.rows.length>0),i=e.filter(a=>a.seq>o);if(i.length===0){d(`
      <p class="success">All data from this session has already been uploaded
      successfully. No recovery is needed.</p>
      <table class="meta-table">
        <tr><td>Session</td><td><code>${r(l)}</code></td></tr>
        <tr><td>Total rows</td><td>${e.length}</td></tr>
      </table>
    `);return}let c=t;if(!c){const a=new URLSearchParams(window.location.search),g=a.get("PROLIFIC_PID")||null,b=a.get("STUDY_ID")||null;c={params:{session_id:l,prolific_pid:g,study_id:b,is_preview:!1},prng_seed_uint32:0,schema_version:f.schema_version,build_id:f.build_id,is_pilot_run:!1,pilot_label:null,started_at_iso:n,user_agent:navigator.userAgent}}const p=e.length-i.length;d(`
    <p>Found session data that was not fully uploaded.</p>
    <table class="meta-table">
      <tr><td>Session</td><td><code>${r(l)}</code></td></tr>
      <tr><td>Started</td><td>${r(n??"unknown")}</td></tr>
      <tr><td>Total rows</td><td>${e.length}</td></tr>
      <tr><td>Already uploaded</td><td>${p} rows</td></tr>
      <tr><td>Pending upload</td><td>${i.length} rows</td></tr>
      <tr><td>Files to upload</td><td>${u.length}</td></tr>
    </table>
    <p>Click the button below to re-upload your data. This usually takes a few seconds.</p>
    <button id="upload-btn">Upload my data</button>
    <div id="progress-area" class="hidden">
      <div class="progress-bar"><div class="progress-bar-fill" id="bar-fill"></div></div>
      <div class="status" id="status-text">Starting&hellip;</div>
    </div>
  `),document.getElementById("upload-btn").addEventListener("click",()=>{T(c)})}async function T(s){const e=document.getElementById("upload-btn"),l=document.getElementById("progress-area"),n=document.getElementById("bar-fill"),o=document.getElementById("status-text");e.disabled=!0,e.textContent="Uploading…",l.classList.remove("hidden");try{const t=await I({session:s,allRuns:!0,onProgress:({bucketIndex:h,totalBuckets:u,bucketLabel:i,status:c})=>{const p=h+1,a=Math.round(p/u*100);n.style.width=`${a}%`;const g=c==="ok"?"✓":"✗";o.textContent=`${g} File ${p} of ${u} (${i})`}});t.status==="uploaded"?(n.style.width="100%",o.innerHTML=`<span class="success">✓ All data uploaded successfully
        (${t.uploadedRows} rows in ${t.uploadedBuckets} files).</span>
        <br><br>You can close this page. Thank you!`,e.textContent="Done"):t.status==="nothing_to_upload"?(o.innerHTML='<span class="success">✓ All data was already uploaded. Nothing to do.</span>',e.textContent="Done"):t.status==="partial"?(n.style.background="#f59e0b",o.innerHTML=`<span class="warn">Partial upload: ${t.uploadedBuckets} of
        ${t.totalBuckets} files sent.</span>
        <br>Error: <code>${r(t.lastError)}</code>
        <br><br>Please try again, or contact the researcher through Prolific messaging.`,e.disabled=!1,e.textContent="Retry"):(o.innerHTML=`<span class="error">Upload could not start (${r(t.status)}).
        Please contact the researcher through Prolific messaging.</span>`,e.disabled=!1,e.textContent="Retry")}catch(t){o.innerHTML=`<span class="error">Unexpected error: ${r(t.message)}</span>
      <br><br>Please try again, or contact the researcher through Prolific messaging.`,e.disabled=!1,e.textContent="Retry"}}S().catch(s=>{console.error("[recover] fatal error",s),d(`<p class="error">Something went wrong: ${r(s.message)}</p>`)});
