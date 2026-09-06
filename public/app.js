let state={accounts:[],codes:[],audit:[]};
let config={telegramConfigured:false};
let es=null;
let authFlowId=sessionStorage.getItem('telegramAuthFlowId')||null;
let authPoll=null;
let chatState={accountId:'',chats:[],activeRef:'',messages:[],oldestId:0,replyTo:0,loading:false};

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
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=async()=>{
    document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));
    $('#'+b.dataset.target).classList.add('active');

    // CHAT_LAZY_LOAD
    if(b.dataset.target==='chats'){
      await loadChats();
    }
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
  if(!v)return 'Unknown';
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

  const chatAccountSelect=$('#chatAccountSelect');
  if(chatAccountSelect){
    const previous=chatAccountSelect.value || chatState.accountId;
    const real=state.accounts.filter(a=>a.authMode==='REAL_TELEGRAM' && a.status==='ACTIVE');
    chatAccountSelect.innerHTML=real.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} | ${esc(a.phone)}</option>`).join('');
    if(real.some(a=>a.id===previous)){
      chatAccountSelect.value=previous;
      chatState.accountId=previous;
    }else if(real[0]){
      chatAccountSelect.value=real[0].id;
      chatState.accountId=real[0].id;
    }else{
      chatState.accountId='';
    }
  }
  const deviceSelect=$('#deviceAccountSelect');
  if(deviceSelect){
    const previous=deviceSelect.value;
    const real=state.accounts.filter(a=>a.authMode==='REAL_TELEGRAM' && a.status==='ACTIVE');
    deviceSelect.innerHTML=real.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} | ${esc(a.phone)}</option>`).join('');
    if(real.some(a=>a.id===previous))deviceSelect.value=previous;
  }

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
  const codeInbox=$('#codeInbox');
  if(codeInbox && !codeInbox.dataset.loaded){
    codeInbox.innerHTML='<div class="muted">Click Refresh to see active per-user login challenges.</div>';
  }


  $('#timeline').innerHTML=state.audit.map(e=>`<div class="event"><time>${esc(dt(e.time))}</time><div><b>${esc(e.title)}</b><p class="muted">${esc(e.text)}</p></div></div>`).join('')||'<div class="muted">No audit entries.</div>';
}

async function login(){
  try{
    await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#loginUser').value,password:$('#loginPass').value})});
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await start();
    await resumePendingTelegramAuth();
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
  es.addEventListener('telegram-message',async e=>{
    try{
      const evt=JSON.parse(e.data||'{}');
      if(evt.accountId===chatState.accountId){
        await loadChats(true);
        if(chatState.activeRef)await loadMessages(chatState.activeRef,true);
      }
    }catch{}
  });
}

function resetAuthModal(){
  clearInterval(authPoll);
  authPoll=null;
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
  clearInterval(authPoll);
  authPoll=null;
  authFlowId=null;
  sessionStorage.removeItem('telegramAuthFlowId');
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
  sessionStorage.removeItem('telegramAuthFlowId');
  authFlowId=null;
  resetAuthModal();
  $('#addModal').classList.add('hidden');
}

async function startTelegramAuth(){
  try{
    if(!config.telegramConfigured)throw new Error('TELEGRAM_CONFIG_REQUIRED');

    const payload={
      name:$('#fName').value,
      phone:$('#fPhone').value.replace(/\s+/g,''),
      country:$('#fCountry').value,
      region:$('#fRegion').value,
      consent:true
    };

    const r=await api('/api/telegram/auth/start',{method:'POST',body:JSON.stringify(payload)});
    authFlowId=r.authId;
    sessionStorage.setItem('telegramAuthFlowId',authFlowId);

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
      sessionStorage.removeItem('telegramAuthFlowId');
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

    if(e.message==='AUTH_FLOW_NOT_FOUND'){
      sessionStorage.removeItem('telegramAuthFlowId');
      authFlowId=null;
      $('#addModal').classList.add('hidden');
      resetAuthModal();
      toast('Login challenge expired. Start Telegram login again.');
      return;
    }

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
    $('#authStageText').textContent='PROCESSING';
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
    $('#authStageText').textContent='PROCESSING';
    await pollAuth();
  }catch(e){toast(e.message)}
}

async function resumePendingTelegramAuth(){
  const saved=sessionStorage.getItem('telegramAuthFlowId');
  if(!saved)return;

  authFlowId=saved;

  try{
    const s=await api(`/api/telegram/auth/${authFlowId}/status`);
    $('#addModal').classList.remove('hidden');
    $('#authStartStep').classList.add('hidden');
    $('#sendCodeBtn').classList.add('hidden');
    $('#authProgressStep').classList.remove('hidden');
    $('#authStageText').textContent=s.stage;
    authPoll=setInterval(pollAuth,800);
    await pollAuth();
  }catch(e){
    if(e.message==='AUTH_FLOW_NOT_FOUND'){
      sessionStorage.removeItem('telegramAuthFlowId');
      authFlowId=null;
    }else{
      toast(e.message);
    }
  }
}

async function loadTelegramDevices(){
  const select=$('#deviceAccountSelect');
  const rows=$('#telegramDeviceRows');
  const summary=$('#deviceSummary');

  if(!select||!select.value){
    rows.innerHTML='<tr><td colspan="7" class="muted">No ACTIVE real Telegram account available.</td></tr>';
    summary.textContent='';
    return;
  }

  rows.innerHTML='<tr><td colspan="7" class="muted">Loading Telegram authorized devices...</td></tr>';
  summary.textContent='';

  try{
    const r=await api(`/api/accounts/${select.value}/telegram-devices`);
    summary.textContent=`Telegram reports ${r.devices.length} authorized session${r.devices.length===1?'':'s'} for this account.`;

    rows.innerHTML=r.devices.map(d=>`<tr>
      <td><b>${esc(d.deviceModel)}</b><br><span class="muted">${esc([d.platform,d.systemVersion].filter(Boolean).join(' '))}</span></td>
      <td>${esc([d.appName,d.appVersion].filter(Boolean).join(' '))}${d.officialApp?'<br><span class="soft">Official app</span>':''}</td>
      <td>${esc([d.country,d.region].filter(Boolean).join(' / ')||'Unknown')}</td>
      <td>${esc(d.ip||'Unknown')}</td>
      <td>${esc(dt(d.dateActive))}</td>
      <td>${d.current?'<span class="tag green">CURRENT</span>':'<span class="soft">Authorized</span>'}</td>
      <td>${d.current
        ? '<span class="muted">Current vault session</span>'
        : `<button class="btn danger" onclick="terminateTelegramDevice('${esc(select.value)}','${esc(d.ref)}','${esc(d.deviceModel)}')">Terminate</button>`
      }</td>
    </tr>`).join('')||'<tr><td colspan="7" class="muted">Telegram returned no authorized sessions.</td></tr>';
  }catch(e){
    rows.innerHTML=`<tr><td colspan="7" class="muted">${esc(e.message)}</td></tr>`;
    toast(e.message);
  }
}

async function terminateTelegramDevice(accountId,ref,deviceName){
  if(!confirm(`Terminate Telegram session on "${deviceName}"? That device will need to log in again.`))return;

  try{
    await api(`/api/accounts/${accountId}/telegram-devices/${ref}/terminate`,{
      method:'POST',
      body:'{}'
    });
    toast('Telegram device session terminated');
    await loadTelegramDevices();
    await load();
  }catch(e){toast(e.message)}
}


async function loadLoginChallenges(){
  const box=$('#codeInbox');
  if(!box)return;

  box.dataset.loaded='1';
  box.innerHTML='<div class="muted">Loading login challenges...</div>';

  try{
    const r=await api('/api/telegram/auth-flows');
    const flows=r.flows||[];

    if(!flows.length){
      box.innerHTML='<div class="muted">No active Telegram login challenges.</div>';
      return;
    }

    box.innerHTML=flows.map(f=>`<div class="bubble">
      <small>${esc(f.name)} | ${esc(f.phone)} | ${esc(dt(f.updatedAt))}</small>
      <div style="margin-top:8px"><b>${esc(f.stage)}</b></div>
      ${f.error?`<div class="muted" style="margin-top:6px">${esc(f.error)}</div>`:''}
      <div style="margin-top:10px">
        ${f.stage==='CODE_REQUIRED'
          ? '<span class="soft">Waiting for the account owner to enter the Telegram login code in the secure Connect Telegram dialog.</span>'
          : f.stage==='PASSWORD_REQUIRED'
          ? '<span class="soft">Waiting for the account owner to enter the Telegram 2FA password in the secure Connect Telegram dialog.</span>'
          : f.stage==='AUTHORIZED'
          ? '<span class="tag green">AUTHORIZED</span>'
          : '<span class="muted">Telegram authorization is processing.</span>'
        }
      </div>
    </div>`).join('');
  }catch(e){
    box.innerHTML=`<div class="muted">${esc(e.message)}</div>`;
    toast(e.message);
  }
}

function initials(name){
  return String(name||'TG').trim().split(/\s+/).map(x=>x[0]||'').join('').slice(0,2).toUpperCase()||'TG';
}
function shortTime(v){
  if(!v)return '';
  try{
    const d=new Date(v), now=new Date();
    if(d.toDateString()===now.toDateString())return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    return d.toLocaleDateString([],{month:'short',day:'numeric'});
  }catch{return ''}
}
function renderChatList(){
  const box=$('#chatList');
  if(!box)return;
  if(!chatState.chats.length){box.innerHTML='<div class="muted chatEmpty">No chats found.</div>';return;}
  box.innerHTML=chatState.chats.map(c=>`<button class="chatItem ${c.ref===chatState.activeRef?'active':''}" onclick="openChat('${c.ref}')">
    <span class="chatAvatar">${esc(initials(c.title))}</span>
    <span class="chatMain">
      <span class="chatTitleRow"><span class="chatName">${esc(c.title)}</span>${c.pinned?'<span class="soft">Pinned</span>':''}</span>
      <span class="chatPreview">${esc(c.preview||c.username||'')}</span>
    </span>
    <span class="chatMeta"><span>${esc(shortTime(c.date))}</span>${c.unreadCount>0?`<span class="unreadBadge">${esc(c.unreadCount)}</span>`:''}</span>
  </button>`).join('');
}
async function loadChats(silent=false){
  const select=$('#chatAccountSelect');
  if(!select || !select.value){
    chatState={accountId:'',chats:[],activeRef:'',messages:[],oldestId:0,replyTo:0,loading:false};
    renderChatList(); return;
  }
  chatState.accountId=select.value;
  const q=$('#chatSearch')?.value.trim()||'';
  if(!silent)$('#chatList').innerHTML='<div class="muted chatEmpty">Loading chats...</div>';
  try{
    const r=await api(`/api/accounts/${chatState.accountId}/chats?limit=40&q=${encodeURIComponent(q)}`);
    chatState.chats=r.chats||[];
    if(chatState.activeRef && !chatState.chats.some(c=>c.ref===chatState.activeRef)){
      chatState.activeRef='';chatState.messages=[];chatState.oldestId=0;
    }
    renderChatList();
    if(!chatState.activeRef && chatState.chats[0] && !silent)await openChat(chatState.chats[0].ref);
  }catch(e){
    const box=$('#chatList'); if(box)box.innerHTML=`<div class="muted chatEmpty">${esc(e.message)}</div>`;
    if(!silent)toast(e.message);
  }
}
async function openChat(ref){
  chatState.activeRef=ref;chatState.messages=[];chatState.oldestId=0;clearReply();renderChatList();
  const chat=chatState.chats.find(c=>c.ref===ref);
  $('#conversationTitle').textContent=chat?.title||'Telegram Chat';
  $('#conversationSub').textContent=chat?.username||'';
  $('#messageList').innerHTML='<div class="muted chatEmpty">Loading messages...</div>';
  await loadMessages(ref,false);
  try{
    await api(`/api/accounts/${chatState.accountId}/chats/${ref}/read`,{method:'POST',body:'{}'});
    if(chat)chat.unreadCount=0;renderChatList();
  }catch{}
}
function renderMessages(scrollBottom=false){
  const box=$('#messageList');if(!box)return;
  if(!chatState.messages.length){box.innerHTML='<div class="muted chatEmpty">No messages in this chat.</div>';return;}
  box.innerHTML=chatState.messages.map(m=>`<div class="messageBubble ${m.outgoing?'out':''}" onclick="setReply(${m.id})">
    ${!m.outgoing && m.sender?`<div class="messageSender">${esc(m.sender)}</div>`:''}
    ${m.replyToMsgId?`<div class="replyTarget">Reply to #${esc(m.replyToMsgId)}</div>`:''}
    <div class="messageText">${esc(m.text||'[Unsupported message]')}</div>
    <div class="messageFooter">${m.edited?'<span>edited</span>':''}<span>${esc(shortTime(m.date))}</span></div>
  </div>`).join('');
  if(scrollBottom)box.scrollTop=box.scrollHeight;
}
async function loadMessages(ref=chatState.activeRef,silent=false){
  if(!ref || !chatState.accountId || chatState.loading)return;
  chatState.loading=true;
  try{
    const r=await api(`/api/accounts/${chatState.accountId}/chats/${ref}/messages?limit=60`);
    if(ref!==chatState.activeRef)return;
    chatState.messages=r.messages||[];chatState.oldestId=chatState.messages[0]?.id||0;
    $('#loadOlderBtn').classList.toggle('hidden',!r.hasMore);renderMessages(!silent);
  }catch(e){
    if(e.message==='CHAT_LIST_EXPIRED_REFRESH_REQUIRED'){chatState.activeRef='';await loadChats();return;}
    if(!silent){$('#messageList').innerHTML=`<div class="muted chatEmpty">${esc(e.message)}</div>`;toast(e.message);}
  }finally{chatState.loading=false;}
}
async function loadOlderMessages(){
  if(!chatState.activeRef || !chatState.oldestId || chatState.loading)return;
  chatState.loading=true;const box=$('#messageList');const oldHeight=box.scrollHeight;
  try{
    const r=await api(`/api/accounts/${chatState.accountId}/chats/${chatState.activeRef}/messages?limit=60&offsetId=${chatState.oldestId}`);
    const older=r.messages||[], seen=new Set(chatState.messages.map(m=>m.id));
    chatState.messages=[...older.filter(m=>!seen.has(m.id)),...chatState.messages];
    chatState.oldestId=chatState.messages[0]?.id||0;
    $('#loadOlderBtn').classList.toggle('hidden',!r.hasMore);renderMessages(false);box.scrollTop=box.scrollHeight-oldHeight;
  }catch(e){toast(e.message)}finally{chatState.loading=false;}
}
function setReply(id){
  chatState.replyTo=Number(id)||0;if(!chatState.replyTo)return;
  $('#replyMessageId').textContent=String(chatState.replyTo);$('#replyBar').classList.remove('hidden');$('#messageComposer').focus();
}
function clearReply(){
  chatState.replyTo=0;const bar=$('#replyBar');if(bar)bar.classList.add('hidden');
}
async function sendChatMessage(){
  if(!chatState.accountId || !chatState.activeRef){toast('Select a Telegram chat first');return;}
  const input=$('#messageComposer'), text=input.value.trim();if(!text)return;input.disabled=true;
  try{
    const r=await api(`/api/accounts/${chatState.accountId}/chats/${chatState.activeRef}/messages`,{
      method:'POST',body:JSON.stringify({text,replyTo:chatState.replyTo||null})
    });
    input.value='';clearReply();
    if(r.message){chatState.messages.push(r.message);renderMessages(true);}
    await loadChats(true);
  }catch(e){toast(e.message)}finally{input.disabled=false;input.focus();}
}
function setupChatUi(){
  const account=$('#chatAccountSelect'), search=$('#chatSearch'), composer=$('#messageComposer');
  if(account)account.onchange=async()=>{chatState.accountId=account.value;chatState.activeRef='';chatState.messages=[];chatState.oldestId=0;await loadChats();};
  if(search){let timer=null;search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>loadChats(),300);};}
  if(composer)composer.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage();}};
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
setupChatUi();

api('/api/me').then(async m=>{
  if(m.authenticated){
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await start();
    await resumePendingTelegramAuth();
  }
}).catch(()=>{});