'use strict';

const { BotPeer } = require('./bot-peer');
const { DEFAULT_AOI_RADIUS } = require('./bot-protocol');

const SIGNAL_URL=process.env.SIGNAL_URL||'ws://127.0.0.1:8090';
const ROOM_ID=process.env.ROOM_ID||'test1';
const BOT_COUNT=Math.max(1,Math.min(1000,Number(process.env.BOT_COUNT)||3));
const BOT_VERBOSE=process.env.BOT_VERBOSE==='1';
const AOI_RADIUS=Math.max(120,Math.min(1400,Number(process.env.AOI_RADIUS)||DEFAULT_AOI_RADIUS));
const JOIN_BATCH=Math.max(1,Math.min(50,Number(process.env.JOIN_BATCH)||20));
const bots=[];
function wait(ms){return new Promise(r=>setTimeout(r,ms));}

async function main(){
  console.log(`[bot-runner] room=${ROOM_ID} bots=${BOT_COUNT} signal=${SIGNAL_URL} batch=${JOIN_BATCH}`);
  for(let start=0;start<BOT_COUNT;start+=JOIN_BATCH){
    const batch=[];
    for(let i=start;i<Math.min(BOT_COUNT,start+JOIN_BATCH);i++){const id=`BOT-${String(i+1).padStart(4,'0')}`;const bot=new BotPeer({id,signalUrl:SIGNAL_URL,room:ROOM_ID,aoiRadius:AOI_RADIUS,verbose:BOT_VERBOSE});bots.push(bot);batch.push(bot.start().then(()=>console.log(`[bot-runner] joined ${id}`)));}
    await Promise.all(batch); await wait(80);
  }
  console.log('[bot-runner] all joined; waiting topology/DataChannel settle');
  const results=await Promise.all(bots.map(b=>b.waitUntilStable(20000)));
  const stable=results.filter(Boolean).length; console.log(`[bot-runner] stable ${stable}/${bots.length}; starting AI only after join phase`);
  for(const bot of bots)bot.startAI();
}
async function shutdown(){console.log('\n[bot-runner] stopping');await Promise.allSettled(bots.map(b=>b.stop()));process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);main().catch(error=>{console.error('[bot-runner] fatal:',error.stack||error.message);process.exit(1);});
