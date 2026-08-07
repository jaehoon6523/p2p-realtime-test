'use strict';

const { BotPeer } = require('./bot-peer');

const SIGNAL_URL=process.env.SIGNAL_URL||'ws://127.0.0.1:8090';
const ROOM_ID=process.env.ROOM_ID||'test1';
const BOT_COUNT=Math.max(1,Math.min(1000,Number(process.env.BOT_COUNT)||3));
const BOT_VERBOSE=process.env.BOT_VERBOSE==='1';
const JOIN_GAP_MS=Math.max(10,Math.min(1000,Number(process.env.BOT_JOIN_GAP_MS)||60));
const SETTLE_TIMEOUT_MS=Math.max(1000,Math.min(30000,Number(process.env.BOT_SETTLE_TIMEOUT_MS)||8000));
const bots=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function main(){
  console.log(`[bot-runner:v4] JOIN phase room=${ROOM_ID} bots=${BOT_COUNT} signal=${SIGNAL_URL}`);
  for(let i=0;i<BOT_COUNT;i++){
    const id=`BOT-${String(i+1).padStart(4,'0')}`;
    const bot=new BotPeer({id,signalUrl:SIGNAL_URL,room:ROOM_ID,verbose:BOT_VERBOSE}); bots.push(bot);
    await bot.start();
    console.log(`[bot-runner:v4] joined ${i+1}/${BOT_COUNT} ${id} assignment=${bot.protocol.selfPolicy?.assignmentId||'-'} direct=${bot.desiredDirectPeers.size}`);
    if(i+1<BOT_COUNT) await wait(JOIN_GAP_MS);
  }
  console.log('[bot-runner:v4] SETTLE phase');
  const deadline=Date.now()+SETTLE_TIMEOUT_MS;
  while(Date.now()<deadline){
    const ready=bots.filter(b=>b.isStable()).length;
    if(ready===bots.length) break;
    await wait(250);
  }
  const ready=bots.filter(b=>b.isStable()).length;
  console.log(`[bot-runner:v4] RUN phase topology ready=${ready}/${bots.length}`);
  for(const bot of bots) bot.enableAI();
}
async function shutdown(){ console.log('\n[bot-runner:v4] stopping'); await Promise.allSettled(bots.map(b=>b.stop())); process.exit(0); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
main().catch(error=>{ console.error('[bot-runner:v4] fatal:',error.stack||error.message); process.exit(1); });
