/*** FibaroAPI for Z-Way********** *******************************************

Version: 0.0.6
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
            var passwd = authHeader.split(":")[1];
            if (authHeader) {
                var _profile = self.controller.profiles.filter(function(profile) { return profile.login === login; })[0];
                if (_profile && ((!_profile.salt && _profile.password === passwd) || (_profile.salt && _profile.password === hashPassword(passwd, _profile.salt)))) {
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
                        // TODO: strange behaviour on Android - status seems not to be updated correctly
                        case "switchRGBW":
                            value = dev.get("metrics:level") === "on";
                            property = "value";
                            break;
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
                        case "thermostat":
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
                        zwayIcon = dev.get("metrics:icon"),
                        property,
                        value,
                        lastBreached,
                        type;
                    
                    switch (deviceType) {
                        case "switchRGBW":
                            value = dev.get("metrics:level") === "on" ? 1 : 0;
                            type = "com.fibaro.FGRGBW441M";
                            property = "value";
                            break;
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
                                case "general_purpose":
                                    switch (zwayIcon) {
                                        case "door":
                                            type = "com.fibaro.doorSensor";
                                            break;
                                        case "motion":
                                            console.log("found Aeon motion sensor");
                                            type = "com.fibaro.motionSensor";
                                            break;
                                    }
                                    break;
                                case "alarm_burglar":
                                    type = "com.fibaro.tamperDetector";
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
                        case "thermostat":
                            value = dev.get("metrics:level") || 0;
                            type = "com.fibaro.thermostatDanfoss";
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
            case "/api/panels/event":
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8"
                    },
                    body: {
//                        "id": 8126,
//                        "type": "DEVICE_EVENT",
//                        "timestamp": 1404723546,
//                        "deviceID": 1701,
//                        "deviceType": "com.fibaro.temperatureSensor",
//                        "propertyName": "value",
//                        "oldValue": 28.6,
//                        "newValue": 26.7
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
                    case "setTargetLevel":
                        self.controller.devices.get(dm.vDevId).performCommand("exact", { level: parseInt(req.query.arg1, 10) });
                        break;
                    case "setColor":
                        self.controller.devices.get(dm.vDevId).performCommand("exact", { red: parseInt(req.query.arg1, 10), green: parseInt(req.query.arg2, 10), blue: parseInt(req.query.arg3, 10)});
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
                            "weather": {},
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

                // Add weather info - what's the sense of this part?!
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
                    "name": "Some device",
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
                        zwayIcon = dev.get("metrics:icon"),
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
                        case "sensorMultiline":
                            // true if openWeather MultilineType is found, used later for api response creation
                            var weather_element = false;
                            if(dev.get("metrics:multilineType") === "openWeather") {
                                var weather_element = true;
                                var weather_conditionCode = dev.get("metrics:zwaveOpenWeather:weather")[0].id.toString();
                                var weather_conditionText = dev.get("metrics:zwaveOpenWeather:weather")[0].description;     // do we need this text, is it shown in the UI?
                                var weather_humidity = dev.get("metrics:zwaveOpenWeather:main:humidity");
                                var weather_wind = dev.get("metrics:zwaveOpenWeather:wind:speed"); 
                                var weather_wind_unit = "km/h";
                                var weather_temp = dev.get("metrics:level");
                                var weather_temp_unit = dev.get("metrics:scaleTitle");
                            }
                            break;
                        case "sensorBinary":
                            deviceControlType = "0";
                            switch (probeType) {
                                case "door-window":
                                    icon = 42;
                                    baseType = "com.fibaro.doorWindowSensor";
                                    type = "com.fibaro.doorSensor";
                                    break;
                                case "motion":
                                    icon = 21;
                                    baseType = "com.fibaro.securitySensor";
                                    type = "com.fibaro.motionSensor";
                                    break
                                case "alarm_burglar":
                                    icon = 94;
                                    baseType = "com.fibaro.sensor";
                                    type = "com.fibaro.seismometer";
                                    break;
                                case "alarm_smoke":
                                    icon = 69;
                                    baseType = "com.fibaro.SmokeDetector";
                                    type = "com.fibaro.FGSS-001";
                                    break;
                                // TODO: only shown on iOS apps - why?
                                case "alarm_heat":
                                    icon = 88;
                                    baseType = "com.fibaro.binarySensor";
                                    type = "com.fibaro.heatDetector";
                                    break;
                                // fix for AEON door and motion sensor
                                case "general_purpose":
                                    switch (zwayIcon) {
                                        case "door":
                                            icon = 44;
                                            baseType = "com.fibaro.securitySensor";
                                            type = "com.fibaro.doorSensor";
                                            break;
                                        case "motion":
                                            icon = 90;
                                            baseType = "com.fibaro.securitySensor";
                                            type = "com.fibaro.FGMS001";
                                            break;
                                    }
                                    break;
                            }
                            break;
                        case "switchRGBW":
                            icon = 15;
                            baseType = "com.fibaro.rgbController";
                            type = "com.fibaro.FGRGBW441M";
                            deviceControlType = "50";
                            break;
                        case "thermostat":
                            icon = 34;
                            baseType = "com.fibaro.thermostat";
                            type = "com.fibaro.thermostatDanfoss";
                            deviceControlType = "0";
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
                                case "humidity":
                                    icon = 31;
                                    type = "com.fibaro.humiditySensor";
                                    break;
                                case "ultraviolet":
                                    icon = 32;
                                    type = "com.fibaro.lightSensor";
                                    unit = " UV";
                                    break;

                                // TODO: all energy elements just shown up on iOS app, but without values
                                case "meterElectric_kilowatt_hour":
                                    icon = 102;
                                    type = "com.fibaro.energyMeter";
                                    unit = "kWh";
                                    break;
                                case "meterElectric_watt":
                                    icon = 102;
                                    type = "com.fibaro.energyMeter";
                                    unit = "W";
                                    break;
                                case "meterElectric_voltage":
                                    icon = 102;
                                    type = "com.fibaro.energyMeter";
                                    unit = "V";
                                    break;
                                case "meterElectric_ampere":
                                    icon = 102;
                                    type = "com.fibaro.energyMeter";
                                    unit = "A";
                                    break;
                                case "meterElectric_power_factor":
                                    icon = 102;
                                    type = "com.fibaro.energyMeter";
                                    unit = "Power Factor";
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
                        case "sensorMultiline":
                            // TODO: there are other possible multiLineTypes (e.g. MultiButton)
                            if(weather_element) {
                                // Fibaro ConditionCodes == Yahoo weather codes, but hard to "translate" openWeather to Yahoo codes.
                                // TODO: weather_conditions.json is more or less a WIP - should be revised for better codes mapping.
                                var fibaroConditionCodes = self.loadModuleJSON("weather_conditions.json");
                                var finalConditionCode = fibaroConditionCodes[weather_conditionCode];
                                
                                // change to night icons from 7pm to 7am
                                // TODO: make night time selectable for user
                                var d = new Date();
                                var isNight = (d.getHours() > 19 || d.getHours() < 7);

                                if(finalConditionCode === 28 && isNight) {
                                    finalConditionCode = 27;
                                }
                                else if (finalConditionCode === 30 && isNight) {
                                    finalConditionCode = 29;
                                }
                                else if (finalConditionCode === 32 && isNight) {
                                    finalConditionCode = 31;
                                }

                                var weather_struct = {
                                    "Temperature": weather_temp,
                                    "TemperatureUnit": weather_temp_unit,
                                    "Humidity": weather_humidity,
                                    "Wind": weather_wind,
                                    "WindUnit": "km/h",
                                    "ConditionCode": finalConditionCode,
                                    "WeatherCondition": weather_conditionText
                                    };
                                ret.body.weather = weather_struct;
                            }
                            break;
                        case "switchBinary":
                        case "switchMultilevel":
                            var dead = 0,
                                value = dev.get("metrics:level") === "on" ? 1 : 0,
                                /*
                                TODO: find way to set "light" as interface manually (maybe via tags?)
                                don't set "light" as default anymore for all, this will prevent CodeDevices 
                                and all switches to be added. This seems to be a much better solution, because
                                it's preventing chaos - if the "switch all" button is used. ;)
                                */
                                interfaces = [];

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
                        case "thermostat":
                            var dead = 0,
                                value = dev.get("metrics:level"),
                                interfaces = [ "zwaveProtection" ]; // maybe not as default?
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
                                    "deviceControlType": deviceControlType,
                                    "targetLevel": value.toString(10),
                                    "value": value.toString(10)
                                }
                            });
                            ret.body.devices.push(struct);
                            break;
                        case "switchRGBW":
                            var dead = 0,
                                value = dev.get("metrics:level"),
                                //RGB only: Z-Way is creating a MultiLevelSwitch for white
                                color_r = dev.get("metrics:color:r"),
                                color_g = dev.get("metrics:color:g"),
                                color_b = dev.get("metrics:color:b"),
                                interfaces = [ "energy", "levelChange", "light", "power"];

                            if (zwayObj) {
                                interfaces.push("zwave");
                                // TODO uncomment this once handler for isFailed is implemented
                                // dead = ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isFailed.value ? 1 : 0;
                                if (!ZWave[zwayObj.zwayName].zway.devices[zwayObj.zwayId].data.isListening.value) interfaces.push("zwaveWakeup");
                            }
                            _.extend(struct, {
                                "interfaces": interfaces,
                                "properties": {
                                    "color": color_r+","+color_g+","+color_b+", 0", // white is unknown, set it always to 0
                                    "dead": dead.toString(10),
                                    "deviceControlType": deviceControlType,
                                    "programsSortOrder": "1,2,3,4,5,172,451", // should we add this?
                                    "rememberColor": "1",
                                    "value": value.toString(10),
                                }
                            });
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
