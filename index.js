/*** FibaroAPI for Z-Way********** *******************************************

Version: 0.0.5
------------------------------------------------------------------------------
Author: Karl Otto
Description:
    Fibaro API implementation
    Project page: https://github.com/kotto83/FibaroAPI
    License: GNU GPLv3
    Readme: check README.md
******************************************************************************/

// ----------------------------------------------------------------------------
// --- Class definition, inheritance and setup
// ----------------------------------------------------------------------------

function FibaroAPI (id, controller) {
    // Call superconstructor first (AutomationModule)
    FibaroAPI.super_.call(this, id, controller);
}

inherits(FibaroAPI, AutomationModule);

_module = FibaroAPI;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

FibaroAPI.prototype.init = function (config) {
    FibaroAPI.super_.prototype.init.call(this, config);

    var self = this;

    if (!this.config.MAC) {
        this.config.MAC = "12:34:56:78:90:ab";
        this.saveConfig();
    }
    
    if (!this.config.HCName) {
        this.config.HCName = "HCZ-" + Math.ceil(Math.random() * 1000000);
        this.saveConfig();
    }
    
    if (!this.config.deviceMapping) this.config.deviceMapping = [];
    
    this.registerFinder();
    this.registerWeb();
};

FibaroAPI.prototype.stop = function () {
    var self = this;

    this.unregisterFinder();
    this.unregisterWeb();
    
    FibaroAPI.super_.prototype.stop.call(this);
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

// Register finder (UDP broadcast on port 44444)
FibaroAPI.prototype.registerFinder = function() {
    var self = this;
    
    if (this.sockFibaroFinder) this.sockFibaroFinder.close();
    
    this.sockFibaroFinder = new sockets.udp();
    this.sockFibaroFinder.reusable(); //!!
    this.sockFibaroFinder.broadcast();
    this.sockFibaroFinder.bind(44444);
    this.sockFibaroFinder.onrecv = function(data, host, port) {
        if (String.fromCharCode.apply(null, new Uint8Array(data)) === "FIBARO") {
            console.log("Got Fibaro Finder request from ", host);
            self.sockFibaroFinder.sendto("ACK " + self.config.HCName + " " + self.config.MAC, host, port);
        }
    }
    this.sockFibaroFinder.listen();
};

FibaroAPI.prototype.unregisterFinder = function() {
    if (this.sockFibaroFinder) {
        this.sockFibaroFinder.close();
        this.sockFibaroFinder = null;
    }
};

// Helper to pad numbers with 0
FibaroAPI.prototype.pad = function(num, n) {
    var padding = "";
    for (var i = 0; i < n; i++) padding += "0";
    return (padding + num.toString(10)).slice(-n);
}

// Filter devices by user profile
FibaroAPI.prototype.devicesByUser = function(profile, filter) {
    var devices = this.controller.devices.filter(function(vDev) { return !vDev.permanently_hidden; });
    
    if (filter) {
        devices = devices.filter(filter);
    }

    if (!profile) {
        return [];
    }
    
    if (profile.role === this.controller.auth.ROLE.ADMIN) {
        return devices;
    } else {
        if (!!profile.rooms) {
            return devices.filter(function(dev) {
                // show only devices from allowed rooms (don't show unallocated devices)
                return dev.get("location") != 0 && profile.rooms.indexOf(dev.get("location")) !== -1;
            });
        } else {
            return [];
        }
    }
};

// Register web handler
FibaroAPI.prototype.registerWeb = function() {
    var self = this;
    
    this.ws = new WebServer(80, function(req) {
        var profile;
        
	// Check Basic Authorization
        var authHeader = req.headers['Authorization'];
        if (authHeader && authHeader.substring(0, 6) === "Basic ") {
            authHeader = Base64.decode(authHeader.substring(6));
            var login = authHeader.split(":")[0];
            if (authHeader) {
                var _profile = self.controller.profiles.filter(function(profile) { return profile.login === login; })[0];
                if (_profile && authHeader === login + ":" + _profile.password) {
                    profile = _profile;
                }
            }
        }
        if (!profile) {
            return {
                status: 401,
                body: "Not logged in"
            };
        }

        function getDevMapByFibaroId(id) {
            id = parseInt(id, 10);
            return self.config.deviceMapping.filter(function(dm) { return dm.fibaroId === id })[0];
        }
        
        function getDevMapByVDevId(id) {
            return self.config.deviceMapping.filter(function(dm) { return dm.vDevId === id })[0];
        }
        
        function createMap(id) {
            var fibaroIdStart = 100;
            var n = Math.max(fibaroIdStart, Math.max.apply(null, self.config.deviceMapping.map(function(x) { return x.fibaroId; })));
            var ret = { vDevId: id, fibaroId: n + 1, order: n + 1 };
            self.config.deviceMapping.push(ret);
            self.saveConfig();
            return ret;
        }
        
        function getZWayByVDevId(id) {
            var pattern = "^((ZWayVDev_([^_]+)_([0-9]+))-([0-9]+))((-[0-9]+)*)",
                match = id.match(pattern);

            if (match) {
                return {
                    vDevRootId: match[2],
                    vDevMasterId: match[1],
                    zwayName: match[3],
                    zwayId: parseInt(match[4], 10)
                };
            } else {
                return null;
            }
        }

        if (0 || 0 && req.url !== "/api/mobile/interface/refreshStates") console.logJS(req); // Debug output (change 0 => 1, first is very verbose, second less verbose)
        
	switch (req.url) {
	    case "/api/loginStatus":
	        if (req.query.action === "login")	        
                    return {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json;charset=UTF-8"
                        },
                        body: {"status": true, "userID": 2, "username": profile.login, "type": "superuser"}
                    };
                break;
            case "/api/mobile/interface/refreshStates":
                var d = new Date(),
                    last = Math.floor(d.getTime() / 1000),
                    since = (req.query && req.query.hasOwnProperty("last")) ? parseInt(req.query.last, 10) : 0,
                    structureChanged = self.controller.lastStructureChangeTime >= since;

                // TODO handle case of structureChanged == true
                var events = self.devicesByUser(profile, function (dev) { 
                    return dev.get("updateTime") >= (structureChanged ? 0 : since);
                }).map(function(dev) {
                    var deviceType = dev.get("deviceType"),
                        probeType = dev.get("probeType"),
                        property,
                        value, oldValue;
                    
                    switch (deviceType) {
                        case "switchBinary":
                            value = dev.get("metrics:level") === "on";
                            //oldValue = !value; // not used
                            property = "value";
                            break;
                        case "switchMultilevel":
                            value = dev.get("metrics:level");
                            property = "value";
                            break;
                        case "sensorBinary":
                            value = dev.get("metrics:level") === "on";
                            property = "value";
                            break;
                        case "sensorMultilevel":
                            value = dev.get("metrics:level");
                            property = "value";
                            break;
                    }
                    
                    var devMap = getDevMapByVDevId(dev.id);
                    if (!devMap) return undefined;
                    
                    return {
                        "type": "DevicePropertyUpdatedEvent",
                        "data": {
                            "id": devMap.fibaroId,
                            "property": property,
                            "oldValue": oldValue, // we do not know old value, we don't save it. Should we?
                            "newValue": value
                        }
                    };
                });
                
                var changes = self.devicesByUser(profile, function (dev) { 
                    return dev.get("updateTime") >= (structureChanged ? 0 : since);
                }).map(function(dev) {
                    var deviceType = dev.get("deviceType"),
                        probeType = dev.get("probeType"),
                        property,
                        value,
                        lastBreached,
                        type;
                    
                    switch (deviceType) {
                        case "switchBinary":
                            value = dev.get("metrics:level") === "on" ? 1 : 0;
                            type = "com.fibaro.binarySwitch";
                            property = "value";
                            break;
                        case "switchMultilevel":
                            value = dev.get("metrics:level") || 0;
                            type = "com.fibaro.binarySwitch";
                            property = "value";
                            break;
                        case "sensorBinary":
                            value = dev.get("metrics:level") === "on" ? 1 : 0;
                            switch(probeType) {
                                case "door-window":
                                    type = "com.fibaro.doorSensor";
                                    break;
                                case "motion":
                                    type = "com.fibaro.motionSensor";
                                    break;
                            }
                            lastBreached = dev.get("updateTime");
                            property = "value";
                            break;
                        case "sensorMultilevel":
                            value = dev.get("metrics:level") || 0;
                            type = "com.fibaro.sensorMulilevel";
                            property = "value";
                            break;
                    }
                    
                    var devMap = getDevMapByVDevId(dev.id);
                    if (!devMap) return undefined;
                    
                    return {
                        "id": devMap.fibaroId,
                        "type": type,
                        "log": "",
                        "logTemp": "",
                        "lastBreached": lastBreached,
                        "value": value !== undefined ? value.toString(10) : undefined
                    };
                });

                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: {
                        "status": "IDLE",
                        "last": last,
                        "date": self.pad(d.getHours(), 2) + ":" + self.pad(d.getMinutes(), 2) + " | " + self.pad(d.getDay(), 2) + "." + self.pad(d.getMonth(), 2) + "." + d.getYear(),
                        "timestamp": Math.ceil((new Date()).getTime()/1000),
                        "logs": [],
                        "events": since ? events : [],
                        "changes": since ? changes : [],
                        "alarmChanges":[]
                    }
                };
            case "/api/modules":
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: []
                };
            case "/api/weather":
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: {
                        "ConditionCode": "32",
                        "Humidity": "0.00",
                        "PreviousConditionCode": "32",
                        "PreviousHumidity": "0.00",
                        "PreviousTemperature": "0.00",
                        "PreviousWeatherConditionConverted": "\\\"cloudy\\\"",
                        "PreviousWind": "0.00",
                        "Temperature": "0",
                        "WeatherCondition": "rain",
                        "WeatherConditionConverted": "cloudy",
                        "Wind": "0.00",
                        "saveLogs": "1",
                        "TemperatureUnit": "C"
                    }
                };
            case "/api/settings/location":
                var d = new Date();
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: {
                        "houseNumber": 3,
                        "timezone": "Europe/Berlin",
                        "timezoneOffset": 7200,
                        "ntp": false,
                        "ntpServer": "pool.ntp.org",
                        "date": { "day": d.getDay(), "month": d.getMonth(), "year": d.getYear() },
                        "time": { "hour": d.getHours(), "minute": d.getMinutes() },
                        "latitude": 52.25,
                        "longitude": 16.53,
                        "city": "Poznan",
                        "temperatureUnit": "C",
                        "windUnit": "km/h",
                        "timeFormat": 24,
                        "dateFormat": "dd.mm.yy",
                        "decimalMark": "."
                    }
                };
            case "/api/mobile/registerDevice":
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: {"mobileDeviceId": 24, "sipDisplayName":""}
                };
            case "/api/callAction":
                var dm = getDevMapByFibaroId(req.query.deviceID);
                if (!dm) break;
                switch (req.query.name) {
                    case "wakeUpDeadDevice":
                        var zwayObj = getZWayByVDevId(dm.vDevId);
                        ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].SendNoOperation();
                        break;
                    case "turnOn":
                    case "turnOff":
                        self.controller.devices.get(dm.vDevId).performCommand(req.query.name === "turnOn" ? "on" : "off");
                        break;
                    case "setValue":
                        self.controller.devices.get(dm.vDevId).performCommand("exact", { level: parseInt(req.query.arg1, 10) });
                        break;
                }
                return {
                    status: 202,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: { "id":0, "jsonrpc": "2.0", "result": { "result": 0 }} // no idea what it means
                }
                break;
            case "/api/mobile/interface/data":
                 var ret = {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json;charset=UTF-8"
                        },
                        body: {
                            "info": {
                                "serialNumber": self.config.HCName,
                                "mac": self.config.MAC,
                                "softVersion": "4.100",
                                "beta": false,
                                "hotelMode": false,
                                "userID": profile.id,
                                "useOptionalPin": false,
                                "temperatureUnit": "C"
                            },
                            "home": {
                                "timestamp": Math.ceil((new Date()).getTime()/1000),
                                "defaultSensors": {
                                    "temperature": 0,
                                    "humidity": 0,
                                    "light": 0
                                },
                                "currency": "EUR"
                            },
                            "weather": {
                                "conditionCode": 32,
                                "humidity": 0,
                                "wind": 0,
                                "windUnit": "km/h",
                                "temperature": 0,
                                "temperatureUnit": "C"
                            },
                            "sections": [],
                            "rooms":[],
                            "devices": [],
                            "scenes": [],
                            "icons": self.loadModuleJSON("icons.json"),
                            "linkedDevices": [],
                            "alarm": [],
                            "satelPartitions": [],
                            "fibaroAlarm": self.loadModuleJSON("fibaroAlarm.json"),
                            "hierarchy": self.loadModuleJSON("hierarchy.json"),
                            "favoriteColors": [],
                            "rgbPrograms": self.loadModuleJSON("rgbPrograms.json")
                        }
                };
                
                var lorder = 0;
                self.controller.locations.forEach(function(loc) {
                    if (loc.id !== 0) {
                        ret.body.rooms.push({
                            "id": loc.id,
                            "name": loc.title,
                            "sectionId": 0,
                            "iconId": 4,
                            "defaultSensors": {
                                 "temperature": 0,
                                 "humidity": 0,
                                 "light": 0,
                                 "thermostat": 0
                            },
                            "sortOrder": ++lorder
                        });
                    }
                });

                // Add current user
                ret.body.devices.push({
                    "id": profile.id,
                    "name": profile.login,
                    "roomId": 0,
                    "iconId": 0,
                    "sortOrder": 2,
                    "baseType": "",
                    "enabled": true,
                    "interfaces": [],
                    "viewXml": false,
                    "type": "HC_user",
                    "properties": {}
                });
                
                // Add weather info
                ret.body.devices.push({
                    "id": 3,
                    "name": "weather",
                    "roomId": 0,
                    "iconId": 0,
                    "sortOrder": 3,
                    "baseType": "",
                    "enabled": true,
                    "interfaces": [],
                    "viewXml": false,
                    "type": "weather",
                    "properties": {}
                });
                
                // Add mobile registered device
                ret.body.devices.push({
                    "id": 24,
                    "name": "Some phone model",
                    "roomId": 0,
                    "iconId": 91,
                    "sortOrder": 6,
                    "baseType": "",
                    "enabled": true,
                    "interfaces": [],
                    "viewXml": false,
                    "type": "iOS_device",
                    "properties": {}
                });
                
                self.devicesByUser(profile).forEach(function(dev) {
                    var devMap = getDevMapByVDevId(dev.id);
                    if (!devMap) devMap = createMap(dev.id);
                    
                    var zwayObj = getZWayByVDevId(dev.id);
                    var deviceType = dev.get("deviceType"),
                        probeType = dev.get("probeType"),
                        scaleTitle = dev.get("metrics:scaleTitle");
                        
                    var icon, baseType, type, unit, deviceControlType;
                    
                    switch (deviceType) {
                        case "switchBinary":
                            icon = 2;
                            baseType = "com.fibaro.actor";
                            type = "com.fibaro.binarySwitch";
                            deviceControlType = "2";
                            break;
                        case "switchMultilevel":
                            icon = 15;
                            baseType = "com.fibaro.binarySwitch";
                            type = "com.fibaro.multilevelSwitch";
                            deviceControlType = "23";
                            break;
                        case "sensorBinary":
                            baseType = "com.fibaro.securitySensor";
                            deviceControlType = "0";
                            switch (probeType) {
                                case "door-window":
                                    icon = 42;
                                    type = "com.fibaro.doorSensor";
                                    break;
                                case "motion":
                                    icon = 21;
                                    type = "com.fibaro.motionSensor";
                                    break;
                            }
                            break;
                        case "sensorMultilevel":
                            baseType = "com.fibaro.multilevelSensor";
                            unit = scaleTitle;
                            deviceControlType = "0";
                            switch (probeType) {
                                case "temperature":
                                    icon = 30;
                                    type = "com.fibaro.temperatureSensor";
                                    unit = undefined; // unit = unit === "°C" ? "C" : "F"; // TODO it in future
                                    break;
                                case "luminosity":
                                    icon = 32;
                                    type = "com.fibaro.lightSensor";
                                    break;
                            }
                            break;
                    }
                    
                    var struct = {
                        "id": devMap.fibaroId,
                        "name": dev.get("metrics:title"),
                        "roomId": dev.get("location"),
                        "sortOrder": devMap.order,
                        "enabled": true,
                        "viewXml": false,
                        "iconId": icon,
                        "baseType": baseType,
                        "type": type,
                    };
                    
                    switch (deviceType) {
                        case "switchBinary":
                        case "switchMultilevel":
                            var dead = 0,
                                value = dev.get("metrics:level") === "on" ? 1 : 0,
                                interfaces = [ "light" ];
                            
                            if (zwayObj) {
                                interfaces.push("zwave");
                                // TODO uncomment this once handler for isFailed is implemented
                                // dead = ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isFailed.value ? 1 : 0;
                                
                                if (self.controller.devices.get(zwayObj.vDevMasterId + "-50-0")) {
                                    interfaces.push("energy");
                                }
                                if (self.controller.devices.get(zwayObj.vDevMasterId + "-50-2")) {
                                    interfaces.push("power");
                                }
                            }
                            _.extend(struct, {
                                "interfaces": interfaces,
                                "properties": {
                                    "dead": dead.toString(10),
                                    "deviceControlType": deviceControlType,
                                    "value": value.toString(10)
                                }
                            });
                            if (struct.interfaces.indexOf("power") !== -1) {
                                var _val = self.controller.devices.get(zwayObj.vDevMasterId + "-50-2").get("metrics:level");
                                if (_val !== null) struct.properties.power = _val.toString(10);
                            }
                            if (deviceType === "switchMultilevel") struct.interfaces.push("levelChange");
                            ret.body.devices.push(struct);
                            break;
                        case "sensorBinary":
                            // We currently don't support Arm - not needed for mobile UI
                            // Disarm will work with any pin
                            var dead = 0,
                                value = dev.get("metrics:level") === "on" ? 1 : 0,
                                updateTime = dev.get("updateTime"),
                                interfaces = [ "fibaroBreach", "fibaroAlarm", "fibaroAlarmArm" ];
                            
                            if (zwayObj) {
                                interfaces.push("zwave");                                
                                // TODO uncomment this once handler for isFailed is implemented
                                // dead = ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isFailed.value ? 1 : 0;
                                if (!ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isListening.value) interfaces.push("zwaveWakeup");
                                
                                if (self.controller.devices.get(zwayObj.vDevRootId + "-0-128")) {
                                    interfaces.push("battery");
                                }
                            }
                            _.extend(struct, {
                                "interfaces": interfaces,
                                "properties": {
                                    "alarmDelay": "0",
                                    "alarmExclude": "0",
                                    "alarmTimeTimestamp": "0",
                                    "armConditions": "{\"auto\":false,\"devices\":[{\"id\":" + devMap.fibaroId + ",\"propertyName\":\"value\",\"propertyValue\":\"0\"}],\"time\":0}",
                                    "armConfig": "0",
                                    "armDelay": "0",
                                    "armError": "{}",
                                    "armTimeTimestamp": "0",
                                    "armed": "0",
                                    "deviceControlType": "0",
                                    "fibaroAlarm": "0",
                                    "lastBreached": updateTime.toString(10),
                                    "dead": dead.toString(10),
                                    "value": value.toString(10),
                                }
                            });
                            ret.body.devices.push(struct);
                            break;
                        case "sensorMultilevel":
                            var dead = 0,
                                value = dev.get("metrics:level") || 0,
                                interfaces = [ ];
                            
                            if (zwayObj) {
                                interfaces.push("zwave");                                
                                // TODO uncomment this once handler for isFailed is implemented
                                // dead = ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isFailed.value ? 1 : 0;
                                if (!ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isListening.value) interfaces.push("zwaveWakeup");
                                
                                if (self.controller.devices.get(zwayObj.vDevRootId + "-0-128")) {
                                    interfaces.push("battery");
                                }
                            }
                            _.extend(struct, {
                                "interfaces": interfaces,
                                "properties": {
                                    "dead": dead.toString(10),
                                    "value": value.toString(10),
                                    "unit": unit
                                }
                            });
                            ret.body.devices.push(struct);
                            break;
                    }
                });
                
                return ret;
	}
	
	return null;
    }, {
	document_root: "htdocs/fibaro" // non existant path, no files will be served
    });
};

FibaroAPI.prototype.unregisterWeb = function() {
    if (this.ws) {
        this.ws.stop();
        this.ws = null;
    }
};
