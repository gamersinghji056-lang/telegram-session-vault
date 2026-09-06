let state={accounts:[],codes:[],audit:[]};
let config={telegramConfigured:false};
let es=null;
let authFlowId=null;
let authPoll=null;

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(url,opt={}){
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
  let data={};
  try{data=await r.json()}catch{}
  if(!r.ok)throw new Error(data.error||`HTTP_${r.status}`);
  return data;
}

function toast(m){
  const t=$('#toast');
  t.textContent=m;
  t.classList.remove('hidden');
  setTimeout(()=>t.classList.add('hidden'),3000);
}

function nav(){
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));
    $('#'+b.dataset.target).classList.add('active');
  });
}

function identity(a){
  const premium=a.premium?'<span class="soft">Premium</span>':'';
  return `<div class="accountCell"><div class="avatar">${esc(a.avatar||'TG')}</div><div><div class="accountName">${esc(a.name)} ${premium}</div><div class="muted">${esc(a.username||'')} | ${esc(a.phone)}</div></div></div>`;
}

function tag(s){
  const good=s==='ACTIVE';
  return `<span class="tag ${good?'green':'red'}">${esc(s)}</span>`;
}

function dt(v){
  try{return new Date(v).toLocaleString()}catch{return v}
}

async function load(){
  [state,config]=await Promise.all([api('/api/state'),api('/api/config')]);
  render();
}

function render(){
  const healthy=state.accounts.filter(a=>a.status==='ACTIVE').length;
  const reauth=state.accounts.filter(a=>a.status==='REAUTH_REQUIRED').length;
  $('#mAccounts').textContent=state.accounts.length;
  $('#mHealthy').textContent=healthy;
  $('#mReauth').textContent=reauth;

  const cn=$('#configNotice');
  if(!config.telegramConfigured){
    cn.textContent='Real Telegram login is not configured. Check TELEGRAM_API_ID, TELEGRAM_API_HASH and SESSION_ENCRYPTION_KEY in Railway Variables, then redeploy.';
    cn.classList.remove('hidden');
  }else{
    cn.classList.add('hidden');
  }

  $('#accountRows').innerHTML=state.accounts.map(a=>`<tr>
    <td>${identity(a)}</td>
    <td>${tag(a.status)}</td>
    <td>${esc(a.authMode||'DEMO')}</td>
    <td>${esc(a.country)}/${esc(a.region)}<br><span class="muted">${esc(a.egressLabel)}</span></td>
    <td><div class="actions">
      <button class="btn" onclick="health('${a.id}')">Check</button>
      ${a.status==='REAUTH_REQUIRED'?`<button class="btn primary" onclick="reconnect('${a.id}')">Re-auth</button>`:''}
      <button class="btn danger" onclick="disconnect('${a.id}')">Disconnect</button>
    </div></td>
  </tr>`).join('')||'<tr><td colspan="5" class="muted">No sessions yet.</td></tr>';

  $('#sessionCards').innerHTML=state.accounts.map(a=>`<div class="card span6">
    <div class="profileHero"><div class="avatar">${esc(a.avatar||'TG')}</div><div>
      <div class="accountName" style="font-size:18px">${esc(a.name)} ${a.premium?'<span class="soft">Premium</span>':''}</div>
      <div class="muted">${esc(a.username)} | ${esc(a.phone)}</div>
      <div class="profileMeta">
        <span class="soft">TG ID ${esc(a.telegramId||'N/A')}</span>
        <span class="soft">${esc(a.authMode||'DEMO')}</span>
        <span class="soft">${esc(a.country)}/${esc(a.region)}</span>
      </div>
    </div></div>
    <div class="actions" style="margin-top:14px">
      <button class="btn" onclick="health('${a.id}')">Health Check</button>
      ${a.status==='REAUTH_REQUIRED'?`<button class="btn primary" onclick="reconnect('${a.id}')">Re-authenticate</button>`:''}
      <button class="btn danger" onclick="disconnect('${a.id}')">Disconnect</button>
    </div>
  </div>`).join('')||'<div class="card span12 muted">No sessions.</div>';

  $('#networkRows').innerHTML=state.accounts.map(a=>`<tr>
    <td>${esc(a.name)}</td><td>${esc(a.country)} / ${esc(a.region)}</td>
    <td>${esc(a.networkMode)}</td><td>${esc(a.egressLabel)}</td><td>${esc(a.egressIp)}</td>
  </tr>`).join('')||'<tr><td colspan="5" class="muted">No network profiles.</td></tr>';

  $('#healthCards').innerHTML=state.accounts.map(a=>`<div class="card span6">
    <h3>${esc(a.name)}</h3>
    <p>${tag(a.status)} <span class="muted">Last check: ${esc(dt(a.lastHealthCheck))}</span></p>
    <div class="actions">
      <button class="btn" onclick="health('${a.id}')">Run Health Check</button>
      ${a.status==='REAUTH_REQUIRED'?`<button class="btn primary" onclick="reconnect('${a.id}')">User Re-auth</button>`:''}
    </div>
  </div>`).join('')||'<div class="card span12 muted">No accounts.</div>';

  $('#codeInbox').innerHTML=state.codes.length?state.codes.map(c=>{
    const a=state.accounts.find(x=>x.id===c.accountId)||{};
    return `<div class="bubble"><small>Simulation | ${esc(dt(c.createdAt))} | ${esc(a.name||'Unknown')}</small>
      <div style="margin-top:7px">Mock login-code UI event</div>
      <div class="otp">${esc(c.code)}</div>
      <small>SIMULATED ONLY</small></div>`;
  }).join(''):'<div class="muted">No mock code events.</div>';

  $('#timeline').innerHTML=state.audit.map(e=>`<div class="event"><time>${esc(dt(e.time))}</time><div><b>${esc(e.title)}</b><p class="muted">${esc(e.text)}</p></div></div>`).join('')||'<div class="muted">No audit entries.</div>';
}

async function login(){
  try{
    await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#loginUser').value,password:$('#loginPass').value})});
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await start();
  }catch(e){toast(e.message)}
}

async function logout(){
  await api('/api/logout',{method:'POST'});
  location.reload();
}

async function start(){
  await load();
  if(es)es.close();
  es=new EventSource('/api/events');
  es.addEventListener('code',async()=>{await load();toast('New mock event received')});
  es.addEventListener('state',load);
}

function resetAuthModal(){
  clearInterval(authPoll);
  authPoll=null;
  authFlowId=null;
  $('#authStartStep').classList.remove('hidden');
  $('#authCodeStep').classList.add('hidden');
  $('#authPasswordStep').classList.add('hidden');
  $('#authProgressStep').classList.add('hidden');
  $('#sendCodeBtn').classList.remove('hidden');
  $('#submitCodeBtn').classList.add('hidden');
  $('#submitPasswordBtn').classList.add('hidden');
  $('#authErrorText').textContent='';
  $('#fCode').value='';
  $('#f2fa').value='';
}

function openAdd(prefill=null){
  resetAuthModal();
  if(prefill){
    $('#fName').value=prefill.name||'';
    $('#fPhone').value=prefill.phone||'';
    $('#fCountry').value=prefill.country||'IN';
    $('#fRegion').value=prefill.region||'Mumbai';
  }
  $('#addModal').classList.remove('hidden');
}

async function closeAdd(){
  if(authFlowId){
    try{await api(`/api/telegram/auth/${authFlowId}/cancel`,{method:'POST',body:'{}'})}catch{}
  }
  resetAuthModal();
  $('#addModal').classList.add('hidden');
}

async function startTelegramAuth(){
  try{
    if(!config.telegramConfigured) throw new Error('TELEGRAM_CONFIG_REQUIRED');
    const payload={
      name:$('#fName').value,
      phone:$('#fPhone').value.replace(/\s+/g,''),
      country:$('#fCountry').value,
      region:$('#fRegion').value,
      consent:true
    };
    const r=await api('/api/telegram/auth/start',{method:'POST',body:JSON.stringify(payload)});
    authFlowId=r.authId;
    $('#authStartStep').classList.add('hidden');
    $('#sendCodeBtn').classList.add('hidden');
    $('#authProgressStep').classList.remove('hidden');
    $('#authStageText').textContent=r.stage;
    authPoll=setInterval(pollAuth,800);
    await pollAuth();
  }catch(e){toast(e.message)}
}

async function pollAuth(){
  if(!authFlowId)return;
  try{
    const s=await api(`/api/telegram/auth/${authFlowId}/status`);
    $('#authStageText').textContent=s.stage;
    $('#authErrorText').textContent=s.error||'';

    if(s.stage==='CODE_REQUIRED'){
      $('#authProgressStep').classList.add('hidden');
      $('#authCodeStep').classList.remove('hidden');
      $('#authPasswordStep').classList.add('hidden');
      $('#submitCodeBtn').classList.remove('hidden');
      $('#submitPasswordBtn').classList.add('hidden');
    }else if(s.stage==='PASSWORD_REQUIRED'){
      $('#authProgressStep').classList.add('hidden');
      $('#authCodeStep').classList.add('hidden');
      $('#authPasswordStep').classList.remove('hidden');
      $('#submitCodeBtn').classList.add('hidden');
      $('#submitPasswordBtn').classList.remove('hidden');
    }else if(['STARTING','CONNECTING','REQUESTING_CODE','PROCESSING'].includes(s.stage)){
      $('#authProgressStep').classList.remove('hidden');
      $('#authCodeStep').classList.add('hidden');
      $('#authPasswordStep').classList.add('hidden');
      $('#submitCodeBtn').classList.add('hidden');
      $('#submitPasswordBtn').classList.add('hidden');
    }else if(s.stage==='AUTHORIZED'){
      clearInterval(authPoll);
      authPoll=null;
      authFlowId=null;
      $('#addModal').classList.add('hidden');
      resetAuthModal();
      await load();
      toast('Telegram account connected');
    }else if(s.stage==='ERROR'||s.stage==='CANCELLED'){
      clearInterval(authPoll);
      authPoll=null;
      $('#authProgressStep').classList.remove('hidden');
      $('#authErrorText').textContent=s.error||s.stage;
      toast(s.error||s.stage);
    }
  }catch(e){
    clearInterval(authPoll);
    authPoll=null;
    $('#authErrorText').textContent=e.message;
    toast(e.message);
  }
}

async function submitTelegramCode(){
  try{
    const code=$('#fCode').value.trim();
    await api(`/api/telegram/auth/${authFlowId}/code`,{method:'POST',body:JSON.stringify({code})});
    $('#authCodeStep').classList.add('hidden');
    $('#submitCodeBtn').classList.add('hidden');
    $('#authProgressStep').classList.remove('hidden');
    await pollAuth();
  }catch(e){toast(e.message)}
}

async function submitTelegramPassword(){
  try{
    const password=$('#f2fa').value;
    await api(`/api/telegram/auth/${authFlowId}/password`,{method:'POST',body:JSON.stringify({password})});
    $('#f2fa').value='';
    $('#authPasswordStep').classList.add('hidden');
    $('#submitPasswordBtn').classList.add('hidden');
    $('#authProgressStep').classList.remove('hidden');
    await pollAuth();
  }catch(e){toast(e.message)}
}

async function health(id){
  try{
    await api(`/api/accounts/${id}/health`,{method:'POST'});
    await load();
    toast('Health check completed');
  }catch(e){toast(e.message)}
}

function reconnect(id){
  const a=state.accounts.find(x=>x.id===id);
  if(a)openAdd(a);
}

async function disconnect(id){
  if(!confirm('Disconnect this stored Telegram session from this vault?'))return;
  try{
    await api(`/api/accounts/${id}`,{method:'DELETE'});
    await load();
    toast('Session disconnected');
  }catch(e){toast(e.message)}
}

async function simulateCode(){
  try{
    await api('/api/mock-code',{method:'POST',body:'{}'});
    await load();
  }catch(e){toast(e.message)}
}

async function clearCodes(){
  await api('/api/codes',{method:'DELETE'});
  await load();
  toast('Mock inbox cleared');
}

$('#loginBtn').onclick=login;
nav();
api('/api/me').then(async m=>{
  if(m.authenticated){
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await start();
  }
}).catch(()=>{});