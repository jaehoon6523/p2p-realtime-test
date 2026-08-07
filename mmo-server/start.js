'use strict';
const fs=require('fs');const path=require('path');const {spawn}=require('child_process');
const BOT_COUNT=Math.max(0,Number(process.env.BOT_COUNT)||0);const PORT=Number(process.env.PORT)||8090;
const requested=process.env.SIGNAL_SERVER_FILE;
const candidates=[requested,'signaling-server-sparse-v4.js','signaling-server.js'].filter(Boolean).map(x=>path.join(__dirname,x));
const signalFile=candidates.find(fs.existsSync);if(!signalFile){console.error('[start-v4] signaling server file not found');process.exit(1);}
console.log(`[start-v4] signal=${path.basename(signalFile)} bots=${BOT_COUNT}`);
const signal=spawn(process.execPath,[signalFile],{stdio:'inherit',env:process.env});let bots=null;
function startBots(){if(BOT_COUNT<=0)return;const env={...process.env,SIGNAL_URL:process.env.BOT_SIGNAL_URL||`ws://127.0.0.1:${PORT}`,BOT_COUNT:String(BOT_COUNT)};bots=spawn(process.execPath,[path.join(__dirname,'server-bots','bot-runner.js')],{stdio:'inherit',env});bots.on('exit',(c,s)=>console.log(`[start-v4] bot runner exited code=${c} signal=${s||'-'}`));}
setTimeout(startBots,800);
function stop(sig){try{bots?.kill(sig)}catch{}try{signal.kill(sig)}catch{}}
process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));signal.on('exit',(code)=>{try{bots?.kill('SIGTERM')}catch{}process.exit(code??1);});
