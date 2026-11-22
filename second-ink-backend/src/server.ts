import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { Runner } from './runner.js';

const config=configFromEnv();
const {app,db,service}=await createApp(config);
const runner=new Runner(service);
const server=app.listen(config.port,config.host,()=>{
  console.log(`Second Ink backend: http://${config.host}:${config.port}/api/health (${db.dialect}, RULES mode)`);
  if(config.embeddedWorker) runner.start();
});
server.on('error',async error=>{console.error(error.message);await runner.stop();await db.close();process.exitCode=1;});
let stopping=false;
async function stop() {
  if(stopping)return;stopping=true;
  // Close SSE and idle HTTP connections before closing the database.
  server.close(); server.closeAllConnections();
  await runner.stop(); await db.close();
}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
