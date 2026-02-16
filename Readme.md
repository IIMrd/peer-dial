peer-dial
=========

peer-dial is a simple Node.js module implementing the Discovery and Launch Protocol DIAL as described in the
[Protocol Specification Document](http://www.dial-multiscreen.org/dial-protocol-specification)

This is a fork of the original [`peer-dial`](https://www.npmjs.com/package/peer-dial) by Fraunhofer FOKUS.

Requirements
============

  * [Node.js](https://nodejs.org/) >= 20
  * An [Express](https://expressjs.com/) v5 application (peer dependency) for the DIAL server

Setup
=====

```bash
npm install @iimrd/peer-dial
```

Run Examples
============

Build the project first, then run the server and client examples in the `test` folder:

```bash
npm run build
node test/dial-server.js
node test/dial-client.js
```

Usage
=====

`@iimrd/peer-dial` provides named exports for `Server`, `Client`, and `DialDevice`.

### DIAL Server

The following example ([test/dial-server.js](test/dial-server.js)) starts a DIAL Server that exposes the "YouTube" app. The server should be discoverable by the YouTube app on iOS or Android — tap the cast button and select your device.

You can extend this to register your own DIAL apps. Configuration parameters like `additionalData`, `namespaces`, `extraHeaders`, etc. are also supported; see the exported `ServerOptions` type for the full list.

```javascript
import { Server } from "@iimrd/peer-dial";
import http from "http";
import express from "express";
import open from "open";

const app = express();
const server = http.createServer(app);

const PORT = 3000;
const MANUFACTURER = "Fraunhofer FOKUS";
const MODEL_NAME = "DIAL Demo Server";

const apps = {
  YouTube: {
    name: "YouTube",
    state: "stopped",
    allowStop: true,
    pid: null,
    launch(launchData) {
      open("http://www.youtube.com/tv?" + launchData);
    },
  },
};

const dialServer = new Server({
  expressApp: app,
  port: PORT,
  prefix: "/dial",
  corsAllowOrigins: "*",
  manufacturer: MANUFACTURER,
  modelName: MODEL_NAME,
  delegate: {
    getApp(appName) {
      return apps[appName];
    },
    launchApp(appName, launchData, callback) {
      console.log("Got request to launch", appName, "with launch data:", launchData);
      const app = apps[appName];
      if (app) {
        app.pid = "run";
        app.state = "starting";
        app.launch(launchData);
        app.state = "running";
      }
      callback(app.pid);
    },
    stopApp(appName, pid, callback) {
      console.log("Got request to stop", appName, "with pid:", pid);
      const app = apps[appName];
      if (app && app.pid == pid) {
        app.pid = null;
        app.state = "stopped";
        callback(true);
      } else {
        callback(false);
      }
    },
  },
});

server.listen(PORT, () => {
  dialServer.start();
  console.log(`DIAL Server is running on PORT ${PORT}`);
});
```

#### CORS

You can control which origins are allowed under [CORS](https://en.wikipedia.org/wiki/Cross-origin_resource_sharing) via the `corsAllowOrigins` option. By default, CORS is disabled. To allow all origins:

```javascript
const dialServer = new Server({
  // ...
  corsAllowOrigins: true,
});
```

`corsAllowOrigins` accepts the same values as the `origin` option of the [cors package](https://www.npmjs.com/package/cors) (string, regex, function, etc.).

### DIAL Client

The following example ([test/dial-client.js](test/dial-client.js)) discovers DIAL devices on the network, queries app info, and launches YouTube.

```javascript
import { Client } from "@iimrd/peer-dial";

const dialClient = new Client();

dialClient
  .on("ready", () => {
    console.log("DIAL client is ready");
  })
  .on("found", (deviceDescriptionUrl, ssdpHeaders) => {
    console.log("DIAL device found at", deviceDescriptionUrl);
    dialClient.getDialDevice(deviceDescriptionUrl, (dialDevice, err) => {
      if (dialDevice) {
        console.log("Got DIAL device:", dialDevice);
        dialDevice.getAppInfo("YouTube", (appInfo, err) => {
          if (appInfo) {
            console.log("YouTube app info:", appInfo);
            dialDevice.launchApp("YouTube", "v=YE7VzlLtp-4", "text/plain", (launchRes, err) => {
              if (typeof launchRes !== "undefined") {
                console.log("YouTube launched successfully", launchRes);
              } else if (err) {
                console.error("Error launching YouTube:", err);
              }
            });
          } else if (err) {
            console.error("YouTube not available on", deviceDescriptionUrl);
          }
        });
      } else if (err) {
        console.error("Error getting device description:", err);
      }
    });
  })
  .on("disappear", (deviceDescriptionUrl) => {
    console.log("DIAL device disappeared:", deviceDescriptionUrl);
  })
  .on("stop", () => {
    console.log("DIAL client stopped");
  })
  .start();
```

API
===

### Exports

| Export | Description |
| --- | --- |
| `Server` | DIAL server (extends `EventEmitter`) |
| `Client` | DIAL client (extends `EventEmitter`) |
| `DialDevice` | Represents a discovered DIAL device |

### TypeScript

The package ships with full type declarations. Key exported interfaces:

- `ServerOptions` — constructor options for `Server`
- `ServerDelegate` — delegate callbacks (`getApp`, `launchApp`, `stopApp`)
- `AppInfo` — application information
- `DeviceInfo` — parsed device description
- `ParsedAppInfo` — app info returned by `DialDevice.getAppInfo`

License
=======

Free for non-commercial use released under the GNU Lesser General Public License v3.0. See LICENSE file.

Contact us for commercial use: famecontact@fokus.fraunhofer.de

Copyright (c) 2015 Fraunhofer FOKUS
