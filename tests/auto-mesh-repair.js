const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const network=fs.readFileSync(path.join(root,'js/transport/network.js'),'utf8');
const launcher=fs.readFileSync(path.join(root,'p2p-mmo-auto-launcher.html'),'utf8');
const boot=fs.readFileSync(path.join(root,'js/core/bootstrap.js'),'utf8');
function need(cond,msg){ if(!cond){ console.error('FAIL:',msg); process.exit(1); } }
need(network.includes('DIRECT_MESH_REPAIR_MS'),'direct mesh repair loop missing');
need(network.includes('repairDesiredDirectMesh'),'repairDesiredDirectMesh missing');
need(network.includes('DIRECT_MESH_REPAIR offer→'),'repair log missing');
need(network.includes("transport==='webrtc'&&!isPeerOpen(id)&&!existing.pc&&myId<id"),'incomplete direct peer reconciliation missing');
need(launcher.includes("launchGap')||900"),'launcher stagger missing');
need(launcher.includes("pssf-auto-status"),'launcher live mesh status missing');
need(boot.includes("type:'pssf-auto-status'"),'AUTO iframe status publisher missing');
console.log('PSSF AUTO mesh repair: PASS');
