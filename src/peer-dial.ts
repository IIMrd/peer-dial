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
import crypto from 'crypto';
import * as ssdp from '@iimrd/peer-ssdp';
import os from 'os';
import { EventEmitter } from 'events';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import xml2js from 'xml2js';
import cors from 'cors';
import type { Express, Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Data passed to the device description XML renderer. */
interface DeviceDescData {
	URLBase: string;
	friendlyName: string;
	manufacturer: string;
	modelName: string;
	uuid: string;
}

/** Data passed to the app description XML renderer. */
interface AppDescData {
	name: string;
	state: string;
	allowStop: boolean;
	rel: string;
	href: string | null;
	additionalData?: Record<string, string>;
	namespaces: Record<string, string>;
}

/** Information about a running or stopped DIAL application. */
export interface AppInfo {
	name: string;
	state?: string;
	pid?: string | null;
	allowStop?: boolean;
	additionalData?: Record<string, string>;
	namespaces?: Record<string, string>;
	[key: string]: unknown;
}

/** Parsed application info returned by DialDevice.getAppInfo. */
export interface ParsedAppInfo {
	name?: string;
	state?: string;
	[key: string]: unknown;
}

/** Delegate callbacks for DIALServer. */
export interface ServerDelegate {
	getApp(this: Request, appName: string): AppInfo | null;
	launchApp(this: Request, appName: string, launchData: string | null, callback: (pid: string | null, err?: Error) => void): void;
	stopApp(this: Request, appName: string, pid: string, callback: (stopped: boolean) => void): void;
}

/** Options for constructing a DIALServer. */
export interface ServerOptions {
	expressApp: Express;
	prefix?: string;
	port?: number | null;
	host?: string | null;
	uuid?: string;
	friendlyName?: string;
	manufacturer?: string;
	modelName?: string;
	maxContentLength?: number | string;
	corsAllowOrigins?: cors.CorsOptions['origin'];
	extraHeaders?: Record<string, string | number | boolean>;
	delegate?: Partial<ServerDelegate>;
}

/** Icon information from a device description. */
export interface IconInfo {
	mimetype?: string;
	width?: string;
	height?: string;
	depth?: string;
	url?: string;
}

/** Device information parsed from the device description XML. */
export interface DeviceInfo {
	descriptionUrl?: string;
	applicationUrl?: string;
	deviceType?: string;
	friendlyName?: string;
	manufacturer?: string;
	modelName?: string;
	UDN?: string;
	iconList?: { icon?: IconInfo } | Array<{ icon?: IconInfo }>;
}

// Augment Express Request for our body-reading middleware
interface DialRequest extends Request {
	text?: string;
	length?: number;
}

// ---------------------------------------------------------------------------
// Template renderers
// ---------------------------------------------------------------------------

const DEVICE_DESC_RENDERER = (data: DeviceDescData): string =>
	`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <URLBase>${data.URLBase}</URLBase>
  <device>
    <deviceType>urn:dial-multiscreen-org:device:dial:1</deviceType>
    <friendlyName>${data.friendlyName}</friendlyName>
    <manufacturer>${data.manufacturer}</manufacturer>
    <modelName>${data.modelName}</modelName>
    <UDN>uuid:${data.uuid}</UDN>
    <iconList>
      <icon>
        <mimetype>image/png</mimetype>
        <width>144</width>
        <height>144</height>
        <depth>32</depth>
        <url>/img/icon.png</url>
      </icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>urn:dial-multiscreen-org:service:dial:1</serviceType>
        <serviceId>urn:dial-multiscreen-org:serviceId:dial</serviceId>
        <controlURL>/ssdp/notfound</controlURL>
        <eventSubURL>/ssdp/notfound</eventSubURL>
        <SCPDURL>/ssdp/notfound</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>
`;

const APP_DESC_RENDERER = (data: AppDescData): string => {
	let ns = "";
	for (const key in data.namespaces) {
		ns += ` xmlns:${key}="${data.namespaces[key]}"`;
	}
	let xml = `<?xml version="1.0" encoding="UTF-8"?>
<service xmlns="urn:dial-multiscreen-org:schemas:dial"${ns} dialVer="1.7">
  <name>${data.name}</name>
  <options allowStop="${data.allowStop}"/>
  <state>${data.state}</state>
`;
	if (data.rel !== undefined && data.href !== undefined && data.href) {
		xml += `  <link rel="${data.rel}" href="${data.href}" />\n`;
	}
	if (data.additionalData !== undefined) {
		xml += '        <additionalData>\n';
		for (const key in data.additionalData) {
			xml += `            <${key}>${data.additionalData[key]}</${key}>\n`;
		}
		xml += '        </additionalData>\n';
	}
	xml += '</service>\n';
	return xml;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_STR = `${os.type()}/${os.release()} UPnP/1.1 famium/0.0.1`;

const getExtraHeaders = (dict?: Record<string, unknown>): Record<string, string | number | boolean> => {
	const extraHeaders: Record<string, string | number | boolean> = {};
	if (typeof dict === "object" && dict !== null) {
		for (const key in dict) {
			const value = dict[key];
			if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
				extraHeaders[key] = value;
			}
		}
	}
	return extraHeaders;
};

const merge = (obj1: Record<string, unknown>, obj2: Record<string, unknown>): Record<string, unknown> => {
	for (const key in obj2) {
		const val1 = obj1[key];
		obj1[key] = val1 || obj2[key];
	}
	return obj1;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class Server extends EventEmitter {
	readonly expressApp: Express;
	readonly prefix: string;
	readonly port: number | null;
	readonly host: string | null;
	readonly uuid: string;
	readonly friendlyName: string;
	readonly manufacturer: string;
	readonly modelName: string;
	readonly maxContentLength: number;
	readonly extraHeaders: Record<string, string | number | boolean>;
	readonly delegate: {
		getApp: ServerDelegate['getApp'] | null;
		launchApp: ServerDelegate['launchApp'] | null;
		stopApp: ServerDelegate['stopApp'] | null;
	};
	private readonly corsOptionsSsdp: cors.CorsOptions;
	private readonly corsOptionsAppsDelegate: (req: cors.CorsRequest, callback: (err: Error | null, options?: cors.CorsOptions) => void) => void;
	readonly ssdpPeer: ssdp.Peer;

	constructor(options: ServerOptions) {
		super();
		this.expressApp = options.expressApp;
		this.prefix = options.prefix || "";
		this.port = options.port ?? null;
		this.host = options.host ?? null;
		this.uuid = options.uuid || crypto.randomUUID();
		this.friendlyName = options.friendlyName || os.hostname() || "unknown";
		this.manufacturer = options.manufacturer || "unknown manufacturer";
		this.modelName = options.modelName || "unknown model";
		this.maxContentLength = Math.max(parseInt(options.maxContentLength as string) || 4096, 4096);
		this.extraHeaders = getExtraHeaders(options.extraHeaders);
		this.delegate = {
			getApp: (options.delegate && typeof options.delegate.getApp === "function") ? options.delegate.getApp : null,
			launchApp: (options.delegate && typeof options.delegate.launchApp === "function") ? options.delegate.launchApp : null,
			stopApp: (options.delegate && typeof options.delegate.stopApp === "function") ? options.delegate.stopApp : null,
		};

		const corsAllowOrigins = options.corsAllowOrigins || false;
		this.corsOptionsSsdp = {
			origin: corsAllowOrigins,
			methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
			exposedHeaders: ['Location'],
		};
		const corsOptionsApps: cors.CorsOptions = {
			origin: corsAllowOrigins,
			methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		};
		this.corsOptionsAppsDelegate = (req: cors.CorsRequest, callback: (err: Error | null, options?: cors.CorsOptions) => void) => {
			const origin = (req as Request).header?.('origin');
			if (!origin) {
				callback(null, { origin: false });
			} else if (!/^(http|https|file):/i.test(origin)) {
				callback(null, { origin: true });
			} else {
				callback(null, corsOptionsApps);
			}
		};

		this.ssdpPeer = ssdp.createPeer();
		this.setupRoutes();
	}

	start(): void {
		this.ssdpPeer.start();
	}

	stop(): void {
		const serviceTypes = [
			"urn:dial-multiscreen-org:service:dial:1",
			"urn:dial-multiscreen-org:device:dial:1",
			"upnp:rootdevice",
			"ssdp:all",
			`uuid:${this.uuid}`,
		];
		const location = `http://{{networkInterfaceAddress}}:${this.port}${this.prefix}/ssdp/device-desc.xml`;
		let remaining = serviceTypes.length;
		const done = () => {
			remaining--;
			if (remaining <= 0) {
				this.ssdpPeer.close();
			}
		};
		for (const st of serviceTypes) {
			this.ssdpPeer.byebye(merge({
				NT: st,
				USN: `uuid:${this.uuid}::${st}`,
				SERVER: SERVER_STR,
				LOCATION: location,
			}, this.extraHeaders) as ssdp.SsdpHeaders, done);
		}
	}

	private setupRoutes(): void {
		const pref = this.prefix;
		const peer = this.ssdpPeer;
		const serviceTypes = [
			"urn:dial-multiscreen-org:service:dial:1",
			"urn:dial-multiscreen-org:device:dial:1",
			"upnp:rootdevice",
			"ssdp:all",
			`uuid:${this.uuid}`,
		];
		const app = this.expressApp;

		// Body-reading middleware
		app.use(pref, (req: DialRequest, _res: Response, next: NextFunction) => {
			if (
				req.is("text/plain") || req.is("text/xml") || req.is("text/json") ||
				req.is("application/xml") || req.is("application/json") ||
				req.is("application/x-www-form-urlencoded")
			) {
				req.text = '';
				req.length = 0;
				req.setEncoding('utf8');
				req.on('data', (chunk: string) => { req.text! += chunk; req.length! += chunk.length; });
				req.on('end', next);
			} else {
				next();
			}
		});

		app.use(`${pref}/apps`, cors(this.corsOptionsAppsDelegate));
		app.use(`${pref}/ssdp`, cors(this.corsOptionsSsdp));

		app.get(`${pref}/apps`, (_req: Request, rsp: Response) => {
			rsp.sendStatus(204);
		});

		app.get(`${pref}/apps/:appName`, (req: Request, rsp: Response) => {
			const baseURL = `${req.protocol}://${req.hostname || req.ip || this.host}:${this.port}${pref}`;
			const appName = req.params["appName"] as string;
			const appInfo = this.delegate.getApp?.call(req, appName) ?? null;

			if (appInfo) {
				const state = appInfo.state || (appInfo.pid && "running") || "stopped";
				const xml = APP_DESC_RENDERER({
					name: appName,
					state,
					allowStop: appInfo.allowStop === true,
					rel: "run",
					href: appInfo.pid ?? null,
					additionalData: appInfo.additionalData,
					namespaces: appInfo.namespaces || {},
				});
				rsp.type('application/xml');
				rsp.send(xml);
			} else {
				rsp.sendStatus(404);
			}
		});

		app.post(`${pref}/apps/:appName`, (req: DialRequest, rsp: Response) => {
			const baseURL = `${req.protocol}://${req.hostname || req.ip || this.host}:${this.port}${pref}`;
			const appName = req.params["appName"] as string;
			const appInfo = this.delegate.getApp?.call(req as Request, appName) ?? null;
			if (!appInfo) {
				rsp.sendStatus(404);
			} else if (req.length && req.length > this.maxContentLength) {
				rsp.sendStatus(413);
			} else {
				const state = appInfo.state || (appInfo.pid && "running") || "stopped";
				this.delegate.launchApp?.call(req as Request, appName, req.text || null, (pid: string | null, err?: Error) => {
					if (err) {
						rsp.sendStatus(503);
					} else if (pid) {
						rsp.setHeader('LOCATION', `${baseURL}/apps/${appName}/${pid}`);
						rsp.sendStatus(state === "stopped" ? 201 : 200);
					} else {
						rsp.sendStatus(state === "stopped" ? 201 : 200);
					}
				});
			}
		});

		app.post(`${pref}/apps/:appName/dial_data`, (req: DialRequest, rsp: Response) => {
			const appName = req.params["appName"] as string;
			const appInfo = this.delegate.getApp?.call(req as Request, appName) ?? null;
			if (!appInfo) {
				rsp.sendStatus(404);
			} else if (req.length && req.length > this.maxContentLength) {
				rsp.sendStatus(413);
			} else {
				rsp.sendStatus(501);
			}
		});

		app.delete(`${pref}/apps/:appName/:pid`, (req: Request, rsp: Response) => {
			const appName = req.params["appName"] as string;
			const pid = req.params["pid"] as string;
			const appInfo = this.delegate.getApp?.call(req, appName) ?? null;
			if (appInfo) {
				if (appInfo.allowStop) {
					if (pid) {
						this.delegate.stopApp?.call(req, appName, pid, (stopped: boolean) => {
							rsp.sendStatus(stopped ? 200 : 400);
						});
					} else {
						rsp.sendStatus(400);
					}
				} else {
					rsp.sendStatus(405);
				}
			} else {
				rsp.sendStatus(404);
			}
		});

		app.get(`${pref}/ssdp/device-desc.xml`, (req: Request, rsp: Response) => {
			const baseURL = `${req.protocol}://${req.hostname || req.ip || this.host}:${this.port}${pref}`;
			const xml = DEVICE_DESC_RENDERER({
				URLBase: baseURL,
				friendlyName: this.friendlyName,
				manufacturer: this.manufacturer,
				modelName: this.modelName,
				uuid: this.uuid,
			});
			rsp.setHeader('Content-Type', 'application/xml');
			rsp.setHeader('Application-URL', `${baseURL}/apps`);
			rsp.send(xml);
		});

		app.get(`${pref}/ssdp/notfound`, (_req: Request, rsp: Response) => {
			rsp.sendStatus(404);
		});

		// SSDP event wiring
		const location = `http://{{networkInterfaceAddress}}:${this.port}${pref}/ssdp/device-desc.xml`;

		peer.on("ready", () => {
			for (const st of serviceTypes) {
				peer.alive(merge({
					NT: st,
					USN: `uuid:${this.uuid}::${st}`,
					SERVER: SERVER_STR,
					LOCATION: location,
				}, this.extraHeaders) as ssdp.SsdpHeaders);
			}
			this.emit("ready");
		});

		peer.on("search", (headers: ssdp.SsdpHeaders, address: ssdp.SsdpAddress) => {
			if (serviceTypes.indexOf(headers.ST as string) !== -1) {
				peer.reply(merge({
					LOCATION: location,
					ST: headers.ST,
					"CONFIGID.UPNP.ORG": 7337,
					"BOOTID.UPNP.ORG": 7337,
					SERVER: SERVER_STR,
					USN: `uuid:${this.uuid}::${headers.ST}`,
				}, this.extraHeaders) as ssdp.SsdpHeaders, address);
			}
		});

		peer.on("close", () => {
			this.emit("stop");
		});
	}
}

// ---------------------------------------------------------------------------
// DialDevice
// ---------------------------------------------------------------------------

export class DialDevice {
	readonly descriptionUrl: string | undefined;
	readonly applicationUrl: string | undefined;
	readonly deviceType: string | undefined;
	readonly friendlyName: string | undefined;
	readonly manufacturer: string | undefined;
	readonly modelName: string | undefined;
	readonly UDN: string | undefined;
	readonly icons: IconInfo[];

	constructor(deviceInfo: DeviceInfo) {
		this.descriptionUrl = deviceInfo.descriptionUrl;
		this.applicationUrl = deviceInfo.applicationUrl;
		this.deviceType = deviceInfo.deviceType;
		this.friendlyName = deviceInfo.friendlyName;
		this.manufacturer = deviceInfo.manufacturer;
		this.modelName = deviceInfo.modelName;
		this.UDN = deviceInfo.UDN;
		this.icons = [];
		if (Array.isArray(deviceInfo.iconList)) {
			for (const item of deviceInfo.iconList) {
				if (item?.icon) this.icons.push(item.icon);
			}
		} else if (deviceInfo.iconList?.icon) {
			this.icons.push(deviceInfo.iconList.icon);
		}
	}

	getAppInfoXml(appName: string, callback: (xml: string | null, err?: Error) => void): void {
		const appUrl = this.applicationUrl && appName ? `${this.applicationUrl}/${appName}` : null;
		if (!appUrl) {
			callback(null, new Error("DIAL appName and DIAL Application-URL cannot be empty for getAppInfo"));
			return;
		}
		http.get(appUrl, (res: IncomingMessage) => {
			if (res.statusCode === 200) {
				let appInfoXml = "";
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => { appInfoXml += chunk; });
				res.on('end', () => { callback(appInfoXml); });
			} else {
				const err = new Error(`Cannot get app info from ${appUrl}`);
				(err as NodeJS.ErrnoException).code = String(res.statusCode);
				callback(null, err);
			}
		}).on('error', (err: Error) => {
			callback(null, err);
		});
	}

	getAppInfo(appName: string, callback: (appInfo: ParsedAppInfo | null, err?: Error) => void): void {
		this.getAppInfoXml(appName, (appInfoXml, err) => {
			if (!appInfoXml || err) {
				callback(null, err);
			} else {
				xml2js.parseString(appInfoXml, {
					trim: true,
					explicitArray: false,
					mergeAttrs: true,
					explicitRoot: false,
					tagNameProcessors: [(tagName: string) => tagName.substring(tagName.indexOf(":") + 1)],
					attrNameProcessors: [(attrName: string) => attrName.substring(attrName.indexOf(":") + 1)],
				}, (err: Error | null, appInfo: ParsedAppInfo) => {
					if (err) {
						callback(null, err);
					} else {
						callback(appInfo);
					}
				});
			}
		});
	}

	launchApp(appName: string, launchData: string | null, contentType: string | null, callback: (result: string | null, err?: Error) => void): void {
		const appUrlStr = this.applicationUrl && appName ? `${this.applicationUrl}/${appName}` : null;
		if (!appUrlStr) {
			callback(null, new Error("DIAL appName and DIAL Application-URL cannot be empty for launchApp"));
			return;
		}
		const appUrl = new URL(appUrlStr);
		const contentLength = (launchData && Buffer.byteLength(launchData)) || 0;
		const options: http.RequestOptions = {
			host: appUrl.hostname,
			port: appUrl.port,
			path: appUrl.pathname + appUrl.search,
			method: 'POST',
			headers: {
				'CONTENT-TYPE': contentType || 'text/plain; charset="utf-8"',
				'CONTENT-LENGTH': contentLength,
			},
		};

		const req = http.request(options, (res: IncomingMessage) => {
			let launchRes = "";
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => { launchRes += chunk; });
			res.on('end', () => {
				if (res.statusCode! >= 400) {
					const err = new Error(`Cannot get app info from ${appUrl}`);
					(err as NodeJS.ErrnoException).code = String(res.statusCode);
					callback(null, err);
				} else {
					callback(launchRes);
				}
			});
		});
		req.on('error', (err: Error) => {
			callback(null, err);
		});
		if (launchData) req.write(launchData);
		req.end();
	}

	stopApp(appName: string, pid: string, callback: (statusCode: number | null, err?: Error) => void): void {
		const stopUrlStr = this.applicationUrl && appName && pid ? `${this.applicationUrl}/${appName}/${pid}` : null;
		if (!stopUrlStr) {
			callback(null, new Error("DIAL appName, pid and DIAL Application-URL cannot be empty for stopApp"));
			return;
		}
		const stopUrl = new URL(stopUrlStr);
		const options: http.RequestOptions = {
			host: stopUrl.hostname,
			port: stopUrl.port,
			path: stopUrl.pathname + stopUrl.search,
			method: 'DELETE',
		};

		const req = http.request(options, (res: IncomingMessage) => {
			callback(res.statusCode ?? null);
		});
		req.on('error', (err: Error) => {
			callback(null, err);
		});
		req.end();
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Client extends EventEmitter {
	readonly ssdpPeer: ssdp.Peer;
	private services: Record<string, ssdp.SsdpHeaders>;

	constructor() {
		super();
		const serviceTypes = [
			"urn:dial-multiscreen-org:service:dial:1",
			"urn:dial-multiscreen-org:device:dial:1",
		];
		this.services = {};
		this.ssdpPeer = ssdp.createPeer();

		this.ssdpPeer.on("ready", () => {
			this.ssdpPeer.search({ ST: "urn:dial-multiscreen-org:device:dial:1" });
			this.ssdpPeer.search({ ST: "urn:dial-multiscreen-org:service:dial:1" });
			this.emit("ready");
		});

		this.ssdpPeer.on("found", (headers: ssdp.SsdpHeaders) => {
			const location = headers.LOCATION as string | undefined;
			if (location && !this.services[location]) {
				this.services[location] = headers;
				this.emit("found", location, headers);
			}
		});

		this.ssdpPeer.on("notify", (headers: ssdp.SsdpHeaders) => {
			const location = headers.LOCATION as string | undefined;
			const nts = headers.NTS as string | undefined;
			const nt = headers.NT as string | undefined;
			if (nt && serviceTypes.indexOf(nt) >= 0) {
				if (location && nts === "ssdp:alive" && !this.services[location]) {
					this.services[location] = headers;
					this.emit("found", location, headers);
				} else if (location && nts === "ssdp:byebye" && this.services[location]) {
					const service = this.services[location];
					delete this.services[location];
					this.emit("disappear", location, service);
				}
			}
		});

		this.ssdpPeer.on("close", () => {
			this.emit("stop");
		});
	}

	start(): void {
		this.ssdpPeer.start();
	}

	refresh(): void {
		this.services = {};
		this.ssdpPeer.search({ ST: "urn:dial-multiscreen-org:device:dial:1" });
		this.ssdpPeer.search({ ST: "urn:dial-multiscreen-org:service:dial:1" });
	}

	stop(): void {
		this.ssdpPeer.close();
	}

	getDialDevice(deviceDescriptionUrl: string, callback: (device: DialDevice | null, err?: Error) => void): void {
		http.get(deviceDescriptionUrl, (res: IncomingMessage) => {
			let applicationUrl = res.headers["application-url"] as string | undefined;
			if (res.statusCode === 200 && applicationUrl) {
				if (applicationUrl.endsWith("/")) {
					applicationUrl = applicationUrl.slice(0, -1);
				}
				let deviceDescriptionXml = "";
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => { deviceDescriptionXml += chunk; });
				res.on('end', () => {
					xml2js.parseString(deviceDescriptionXml, {
						trim: true,
						explicitArray: false,
					}, (err: Error | null, deviceDescription: { root?: { device?: DeviceInfo } }) => {
						if (err) {
							callback(null, err);
						} else {
							try {
								const deviceInfo = deviceDescription.root!.device!;
								deviceInfo.descriptionUrl = deviceDescriptionUrl;
								deviceInfo.applicationUrl = applicationUrl;
								const dialDevice = new DialDevice(deviceInfo);
								callback(dialDevice);
							} catch (e) {
								callback(null, e as Error);
							}
						}
					});
				});
			} else {
				callback(null, new Error(`Cannot get device description from ${deviceDescriptionUrl} or Application-URL header is not set`));
			}
		}).on('error', (err: Error) => {
			callback(null, err);
		});
	}
}
