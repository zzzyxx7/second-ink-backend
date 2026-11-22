import { Store } from './db.js';
import { configFromEnv } from './config.js';
import { Service } from './service.js';
import { Runner } from './runner.js';

const config=configFromEnv();
const db=await new Store(config).open();
const runner=new Runner(new Service(db,config));
runner.start();console.log(`Second Ink worker started (${db.dialect}, RULES mode)`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await runner.stop();await db.close();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
