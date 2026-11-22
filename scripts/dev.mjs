import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const compiler=require.resolve('typescript/bin/tsc');
const initial=spawn(process.execPath,[compiler],{stdio:'inherit'});
const code=await new Promise(resolve=>initial.once('exit',resolve));
if(code!==0)process.exit(Number(code)||1);
const children=[
  spawn(process.execPath,[compiler,'--watch','--preserveWatchOutput'],{stdio:'inherit'}),
  spawn(process.execPath,['--watch','dist/server.js'],{stdio:'inherit'})
];
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of children)child.once('exit',()=>stop());
