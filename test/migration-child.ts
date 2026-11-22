import { Store } from '../src/db.js';
const db=await new Store({dataDir:process.argv[2]!,databaseUrl:'',host:'127.0.0.1',port:3080,embeddedWorker:false,frontendOrigin:'',sessionHours:1}).open();
await db.close();console.log('migrated');
