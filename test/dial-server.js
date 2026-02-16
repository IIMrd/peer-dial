/*******************************************************************************
 * 
 * Copyright (c) 2015 Louay Bassbouss, Fraunhofer FOKUS, All rights reserved.
 * 
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3.0 of the License, or (at your option) any later version.
 * 
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 * 
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library. If not, see <http://www.gnu.org/licenses/>. 
 * 
 * AUTHORS: Louay Bassbouss (louay.bassbouss@fokus.fraunhofer.de)
 *
 ******************************************************************************/
import { Server } from "../lib/peer-dial.js";
import http from 'http';
import express from 'express';
import open from 'open';

const app = express();
const server = http.createServer(app);

const PORT = 3000;
const MANUFACTURER = "Fraunhofer FOKUS";
const MODEL_NAME = "DIAL Demo Server";

const apps = {
"YouTube": {
name: "YouTube",
state: "stopped",
allowStop: true,
pid: null,
        launch: function (launchData) {
            open("http://www.youtube.com/tv?"+launchData);
        }
}
};
const dialServer = new Server({
expressApp: app,
port: PORT,
  prefix: "/dial",
corsAllowOrigins: "*",
manufacturer: MANUFACTURER,
modelName: MODEL_NAME,
delegate: {
getApp: function(appName){
const app = apps[appName];
return app;
},
launchApp: function(appName,lauchData,callback){
console.log("Got request to launch", appName," with launch data: ", lauchData);
const app = apps[appName];
if (app) {
app.pid = "run";
app.state = "starting";
                app.launch(lauchData);
                app.state = "running";
}
callback(app.pid);
},
stopApp: function(appName,pid,callback){
            console.log("Got request to stop", appName," with pid: ", pid);
const app = apps[appName];
if (app && app.pid == pid) {
app.pid = null;
app.state = "stopped";
callback(true);
} 
else {
callback(false);
}
}
}
});

server.listen(PORT,function(){
dialServer.start();
console.log(`DIAL Server is running on PORT ${PORT}`);
});
