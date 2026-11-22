import { Store } from '../src/db.js';
import { Service } from '../src/service.js';
import { Runner } from '../src/runner.js';
const config={dataDir:process.argv[2]!,databaseUrl:'',host:'127.0.0.1',port:3080,embeddedWorker:false,frontendOrigin:'',sessionHours:1};
const db=await new Store(config).open();
try{await new Runner(new Service(db,config)).processOne();}finally{await db.close();}
