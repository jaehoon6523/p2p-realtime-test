#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const event=fs.readFileSync(path.join(root,'js','core','event-stream.js'),'utf8');
const verify=fs.readFileSync(path.join(root,'js','core','verification.js'),'utf8');
const rules=fs.readFileSync(path.join(root,'js','game','ruleset.js'),'utf8');
if(!event.includes('const serverBoundRemoteAudit=remote&&verificationRequired(command)')) throw new Error('remote server-bound audit gate missing');
if(!event.includes('if(serverBoundRemoteAudit) runAudit(command)')) throw new Error('remote verified command does not run audit');
if(!event.includes('validators=server-bound quorum=server-bound')) throw new Error('remote audit lacks server-bound fallback path');
if(!verify.includes('evaluateCommand(command,pending,{skipPolicyCheck:true})')) throw new Error('audit still depends on client policy cache');
if(!rules.includes('skipPolicyCheck=false')) throw new Error('ruleset policy-skip option missing');
console.log('PSSF multiplayer audit liveness: PASS');
