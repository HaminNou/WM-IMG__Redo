import{i as b,g as w,w as m,x as y,k as $,y as v,z as _,c as h,u as x}from"./uploader-DR0DR-2V.js";const P=document.getElementById("mount");function l(s){P.innerHTML=`<h2>Data Recovery</h2>${s}`}function r(s){return String(s).replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e])}async function I(){let s;try{s=(await b()).kind}catch{l(`
      <p class="error">Could not open browser storage. This can happen if you
      cleared your browser data or are using a different browser than the one
      you used for the experiment.</p>
    `);return}if(s==="memory"){l(`
      <p class="error">No persistent storage found. IndexedDB is unavailable in
      this browser. Please use the same browser you used for the experiment
      (Chrome, Firefox, or Edge on a desktop computer).</p>
    `);return}const e=await w();if(!e||e.length===0){l(`
      <p class="warn">No session data found in this browser. This can happen if:</p>
      <ul>
        <li>You cleared your browser data since the experiment</li>
        <li>You are using a different browser or device</li>
        <li>You are in a private/incognito window</li>
      </ul>
      <p>If you have the downloaded JSON file, please send it to the
      researcher through Prolific messaging.</p>
    `);return}const i=await m(),n=await y(),a=await $(),t=await v(),u=_(t).filter(o=>o.rows.length>0);if(t.length===0){l(`
      <p class="success">All data from this session has already been uploaded
      successfully. No recovery is needed.</p>
      <table class="meta-table">
        <tr><td>Session</td><td><code>${r(i)}</code></td></tr>
        <tr><td>Total rows</td><td>${e.length}</td></tr>
      </table>
    `);return}let d=a;if(!d){const o=new URLSearchParams(window.location.search),c=o.get("PROLIFIC_PID")||null,g=o.get("STUDY_ID")||null;d={params:{session_id:i,prolific_pid:c,study_id:g,is_preview:!1},prng_seed_uint32:0,schema_version:h.schema_version,build_id:h.build_id,is_pilot_run:!1,pilot_label:null,started_at_iso:n,user_agent:navigator.userAgent}}const p=e.length-t.length;l(`
    <p>Found session data that was not fully uploaded.</p>
    <table class="meta-table">
      <tr><td>Session</td><td><code>${r(i)}</code></td></tr>
      <tr><td>Started</td><td>${r(n??"unknown")}</td></tr>
      <tr><td>Total rows</td><td>${e.length}</td></tr>
      <tr><td>Already uploaded</td><td>${p} rows</td></tr>
      <tr><td>Pending upload</td><td>${t.length} rows</td></tr>
      <tr><td>Files to upload</td><td>${u.length}</td></tr>
    </table>
    <p>Click the button below to re-upload your data. This usually takes a few seconds.</p>
    <button id="upload-btn">Upload my data</button>
    <div id="progress-area" class="hidden">
      <div class="progress-bar"><div class="progress-bar-fill" id="bar-fill"></div></div>
      <div class="status" id="status-text">Starting&hellip;</div>
    </div>
  `),document.getElementById("upload-btn").addEventListener("click",()=>{S(d)})}async function S(s){const e=document.getElementById("upload-btn"),i=document.getElementById("progress-area"),n=document.getElementById("bar-fill"),a=document.getElementById("status-text");e.disabled=!0,e.textContent="Uploading…",i.classList.remove("hidden");try{const t=await x({session:s,allRuns:!0,onProgress:({bucketIndex:u,totalBuckets:d,bucketLabel:p,status:o})=>{const c=u+1,g=Math.round(c/d*100);n.style.width=`${g}%`;const f=o==="ok"?"✓":"✗";a.textContent=`${f} File ${c} of ${d} (${p})`}});t.status==="uploaded"?(n.style.width="100%",a.innerHTML=`<span class="success">✓ All data uploaded successfully
        (${t.uploadedRows} rows in ${t.uploadedBuckets} files).</span>
        <br><br>You can close this page. Thank you!`,e.textContent="Done"):t.status==="nothing_to_upload"?(a.innerHTML='<span class="success">✓ All data was already uploaded. Nothing to do.</span>',e.textContent="Done"):t.status==="partial"?(n.style.background="#f59e0b",a.innerHTML=`<span class="warn">Partial upload: ${t.uploadedBuckets} of
        ${t.totalBuckets} files sent.</span>
        <br>Error: <code>${r(t.lastError)}</code>
        <br><br>Please try again, or contact the researcher through Prolific messaging.`,e.disabled=!1,e.textContent="Retry"):(a.innerHTML=`<span class="error">Upload could not start (${r(t.status)}).
        Please contact the researcher through Prolific messaging.</span>`,e.disabled=!1,e.textContent="Retry")}catch(t){a.innerHTML=`<span class="error">Unexpected error: ${r(t.message)}</span>
      <br><br>Please try again, or contact the researcher through Prolific messaging.`,e.disabled=!1,e.textContent="Retry"}}I().catch(s=>{console.error("[recover] fatal error",s),l(`<p class="error">Something went wrong: ${r(s.message)}</p>`)});
