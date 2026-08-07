'use strict';

const { BotPeer } = require('./bot-peer');

const SIGNAL_URL=process.env.SIGNAL_URL||'ws://127.0.0.1:8090';
const ROOM_ID=process.env.ROOM_ID||'test1';
const BOT_COUNT=Math.max(1,Math.min(60,Number(process.env.BOT_COUNT)||3));
const BOT_VERBOSE=process.env.BOT_VERBOSE==='1';
const COMMITTEE_SIZE=Math.max(1,Math.min(7,Number(process.env.COMMITTEE_SIZE)||3));
const bots=[];

async function main(){
  console.log(`[bot-runner] room=${ROOM_ID} bots=${BOT_COUNT} signal=${SIGNAL_URL}`);
  if(BOT_COUNT>20) console.warn('[bot-runner] 현재 브라우저 프로토콜이 membershipIds<=64라 큰 수는 full-mesh 부하가 급격히 커집니다. 봇 자체가 서버를 잡아먹는 인간적인 광경이 펼쳐질 수 있습니다.');
  for(let i=0;i<BOT_COUNT;i++){
    const id=`BOT-${String(i+1).padStart(3,'0')}`;
    const bot=new BotPeer({id,signalUrl:SIGNAL_URL,room:ROOM_ID,committeeSize:COMMITTEE_SIZE,verbose:BOT_VERBOSE}); bots.push(bot);
    await bot.start();
    console.log(`[bot-runner] joined ${id}`);
    await new Promise(r=>setTimeout(r,120));
  }
}
async function shutdown(){ console.log('\n[bot-runner] stopping'); await Promise.allSettled(bots.map(b=>b.stop())); process.exit(0); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
main().catch(error=>{ console.error('[bot-runner] fatal:',error.stack||error.message); process.exit(1); });
