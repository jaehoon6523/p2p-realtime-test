'use strict';

const fs=require('fs');
const path=require('path');
const http=require('http');
const {spawn}=require('child_process');

const BOT_COUNT=Math.max(0,Number(process.env.BOT_COUNT)||0);
const PORT=Number(process.env.PORT)||8090;
const requested=process.env.SIGNAL_SERVER_FILE;
const candidates=[requested,'signaling-server.js','signaling-server-sparse-v4.js'].filter(Boolean).map(x=>path.join(__dirname,x));
const signalFile=candidates.find(fs.existsSync);
if(!signalFile){ console.error('[start-v4] signaling server file not found'); process.exit(1); }

console.log(`[start-v4] signal=${path.basename(signalFile)} bots=${BOT_COUNT}`);
const signal=spawn(process.execPath,[signalFile],{stdio:'inherit',env:process.env});
let bots=null,stopping=false;

function probeSignal(){
  return new Promise(resolve=>{
    const req=http.get({host:'127.0.0.1',port:PORT,path:'/',timeout:800},res=>{
      let body=''; res.on('data',c=>body+=c); res.on('end',()=>{
        try{ const data=JSON.parse(body); resolve(res.statusCode===200&&data.signalProtocol===4); }
        catch{ resolve(false); }
      });
    });
    req.on('timeout',()=>{req.destroy();resolve(false);});
    req.on('error',()=>resolve(false));
  });
}
async function waitForSignal(){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    if(await probeSignal()) return true;
    await new Promise(r=>setTimeout(r,200));
  }
  return false;
}
async function startBots(){
  if(BOT_COUNT<=0) return;
  if(!(await waitForSignal())){ console.error('[start-v4] signaling readiness timeout; bots not started'); stop('SIGTERM'); process.exit(1); }
  const env={...process.env,SIGNAL_URL:process.env.BOT_SIGNAL_URL||`ws://127.0.0.1:${PORT}`,BOT_COUNT:String(BOT_COUNT)};
  console.log(`[start-v4] signaling ready; starting bots url=${env.SIGNAL_URL}`);
  bots=spawn(process.execPath,[path.join(__dirname,'server-bots','bot-runner.js')],{stdio:'inherit',env});
  bots.on('exit',(c,s)=>{ console.log(`[start-v4] bot runner exited code=${c} signal=${s||'-'}`); if(!stopping&&c!==0) process.exitCode=1; });
}
function stop(sig){
  if(stopping) return; stopping=true;
  try{bots?.kill(sig);}catch{}
  try{signal.kill(sig);}catch{}
}
process.on('SIGTERM',()=>stop('SIGTERM'));
process.on('SIGINT',()=>stop('SIGINT'));
signal.on('exit',(code)=>{ try{bots?.kill('SIGTERM');}catch{} if(!stopping||code) process.exit(code??1); });
startBots().catch(err=>{ console.error('[start-v4] startup failed',err); stop('SIGTERM'); process.exit(1); });
