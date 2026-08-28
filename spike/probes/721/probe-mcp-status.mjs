import { spawn } from 'node:child_process';
const cwd = process.argv[2] || process.cwd();
const cli = 'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const args = ['--output-format','stream-json','--verbose','--input-format','stream-json',
  '--permission-prompt-tool','stdio','--replay-user-messages','--include-partial-messages'];
const child = spawn(cli, args, { cwd, stdio: ['pipe','pipe','pipe'] });
let buf=''; let n=0;
const send=(request)=>{const id='sb-'+(++n);child.stdin.write(JSON.stringify({type:'control_request',request_id:id,request})+'\n');return id;};
child.stdout.on('data', d=>{ buf+=d.toString(); let i;
  while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim())continue;
    let m; try{m=JSON.parse(line)}catch{ console.log('RAW:',line.slice(0,300)); continue }
    if(m.type==='system'&&m.subtype==='init'){ console.log('INIT.mcp_servers =',JSON.stringify(m.mcp_servers)); }
    else if(m.type==='control_response'){ const r=m.response||{};
      console.log('RESP',r.subtype,'=',JSON.stringify(r.response??r.error).slice(0,3000)); }
    else console.log('MSG',m.type,m.subtype||'');
  }});
child.stderr.on('data',d=>process.stderr.write('[err] '+d));
setTimeout(()=>{ console.log('-> initialize'); send({subtype:'initialize'}); },500);
setTimeout(()=>{ console.log('-> mcp_status'); send({subtype:'mcp_status'}); },4000);
setTimeout(()=>{ child.kill(); process.exit(0); },30000);
