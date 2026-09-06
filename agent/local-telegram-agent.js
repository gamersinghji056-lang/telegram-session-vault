const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage } = require('teleproto/events');

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '');
const SESSION_KEY = String(process.env.LOCAL_AGENT_SESSION_KEY || '');
const DATA_DIR = process.env.LOCAL_AGENT_DATA_DIR || path.join(os.homedir(), '.telegram-session-vault-agent');
const SESSION_FILE = path.join(DATA_DIR, 'session.enc');

function die(message){ console.error('\nERROR:', message); process.exit(1); }
if(!Number.isInteger(API_ID) || API_ID <= 0 || API_HASH.length < 8) die('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.');
if(SESSION_KEY.length < 32) die('LOCAL_AGENT_SESSION_KEY must be at least 32 characters.');
fs.mkdirSync(DATA_DIR,{recursive:true});
const rl=readline.createInterface({input:process.stdin,output:process.stdout});

function ask(label, hidden=false){
  if(!hidden) return new Promise(resolve=>rl.question(label,v=>resolve(String(v||'').trim())));
  return new Promise(resolve=>{
    const input=process.stdin, output=process.stdout;
    output.write(label); let value=''; const oldRaw=!!input.isRaw;
    if(input.setRawMode) input.setRawMode(true); input.resume();
    const onData=(chunk)=>{
      const s=chunk.toString('utf8');
      if(s==='\r' || s==='\n'){ input.off('data',onData); if(input.setRawMode) input.setRawMode(oldRaw); output.write('\n'); resolve(value.trim()); return; }
      if(s==='\u0003') process.exit(130);
      if(s==='\u007f' || s==='\b'){ value=value.slice(0,-1); return; }
      value+=s;
    };
    input.on('data',onData);
  });
}
function key(){ return crypto.createHash('sha256').update(SESSION_KEY,'utf8').digest(); }
function encryptSession(text){
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const encrypted=Buffer.concat([cipher.update(String(text),'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
  return [iv,tag,encrypted].map(x=>x.toString('base64url')).join('.');
}
function decryptSession(blob){
  const [iv,tag,data]=String(blob||'').split('.'); if(!iv || !tag || !data) throw new Error('INVALID_LOCAL_SESSION');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));
  decipher.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
}
function loadSession(){
  if(!fs.existsSync(SESSION_FILE)) return '';
  try{return decryptSession(fs.readFileSync(SESSION_FILE,'utf8'));}catch{console.warn('Saved session cannot be decrypted. Normal Telegram login will be required.');return '';}
}
function saveSession(value){ fs.writeFileSync(SESSION_FILE,encryptSession(value),{encoding:'utf8',mode:0o600}); }
function isTelegramService(msg){
  const senderId=String(msg?.senderId ?? msg?.sender?.id ?? '');
  const username=String(msg?.sender?.username || '').toLowerCase();
  return senderId==='777000' || username==='telegram';
}

async function main(){
  console.log('Telegram Session Vault - Local Agent');
  console.log('Telegram connection will originate from THIS PC/network.');
  console.log('Railway is not used as Telegram egress.');
  console.log('Local encrypted session:',SESSION_FILE);

  const client=new TelegramClient(new StringSession(loadSession()),API_ID,API_HASH,{connectionRetries:5});
  await client.connect();
  let authorized=await client.checkAuthorization();

  if(!authorized){
    const consent=(await ask('Connect your own Telegram account from this PC? Type YES: ')).toUpperCase();
    if(consent!=='YES') die('Consent not provided.');
    const phone=await ask('Phone (+country code): ');
    if(!/^\+[1-9]\d{7,14}$/.test(phone)) die('Phone must be E.164 format.');
    await client.start({
      phoneNumber:async()=>phone,
      phoneCode:async()=>await ask('Telegram login code: ',true),
      password:async()=>await ask('Telegram 2FA password if requested: ',true),
      onError:(err)=>console.error('Telegram login:',String(err?.errorMessage || err?.message || err))
    });
    authorized=await client.checkAuthorization();
    if(!authorized) die('Telegram authorization failed.');
    saveSession(client.session.save());
  }else saveSession(client.session.save());

  const me=await client.getMe();
  const name=[me?.firstName,me?.lastName].filter(Boolean).join(' ') || me?.username || String(me?.id || 'Telegram user');
  console.log('\nConnected as:',name);
  console.log('Telegram now sees this PC/network as the connection origin.');
  console.log('Only Telegram official login/security notices are shown here.');
  console.log('Press Ctrl+C to stop.\n');

  client.addEventHandler(async(event)=>{
    const msg=event?.message;
    if(!msg || msg.out || !isTelegramService(msg)) return;
    const text=String(msg.message || msg.text || '[Telegram service notice]');
    console.log('\n[Telegram]',text,'\n');
  },new NewMessage({}));

  try{await client.catchUp();}catch{}
  const shutdown=async()=>{try{saveSession(client.session.save())}catch{} try{await client.disconnect()}catch{} rl.close(); process.exit(0);};
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
  await new Promise(()=>{});
}
main().catch(err=>{console.error('\nAgent stopped:',String(err?.errorMessage || err?.message || err));rl.close();process.exit(1);});