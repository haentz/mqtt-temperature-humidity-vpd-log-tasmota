// Sonoff-Tasmota Temperature Sensor Accessory plugin for HomeBridge with log and min-max temp by @MacWyznawca Jaromir Kopp
'use strict';

var Service, Characteristic;
var mqtt = require("mqtt");
var inherits = require('util').inherits;

var schedule = require('node-schedule');

module.exports = function(homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory("homebridge-mqtt-temperature-humidity-vpd-log-tasmota", "homebridge-mqtt-temperature-humidity-vpd-log-tasmota", TemperatureHumidityVPDLogTasmotaAccessory);
}

function convertDateToStr(date) {
	let dateNew = new Date(date);
	if (dateNew > 0) var dateStr = dateNew.toISOString().replace(/T/, ' ').replace(/\..+/, '');
	else dateStr = "";
	return dateStr;
}

function convertDateTofilename(date) {
	date = new Date(date);
	var localOffset = date.getTimezoneOffset() * 60000;
	var localTime = date.getTime();
	date = localTime - localOffset;
	date = new Date(date).toISOString().replace(/T.+/, '');
	return date;
}

function TemperatureHumidityVPDLogTasmotaAccessory(log, config) {
	this.fs = require("graceful-fs");

	this.log = log;
	this.name = config["name"] || "Sonoff";
	this.manufacturer = config["manufacturer"] || "ITEAD";
	this.model = config["model"] || "Sonoff";
	this.serialNumberMAC = config["serialNumberMAC"] || "";

	this.url = config["url"];
	this.topic = config["topic"];

	this.sensorPropertyName = config["sensorPropertyName"] || "Sensor";

	this.filename = this.topic.split("/")[1];
	this.savePeriod = parseInt(config["savePeriod"]) || 60; // in minutes.
	this.savePeriod = this.savePeriod < 2 ? 2 : this.savePeriod; // min. period 10 minutes

	/////		this.savePeriod = 1; // FOR TEST ONLY!!!
    this.writeMinAndMax = config["writeMinAndMax"];
    this.singleFile = config["singleFile"] || false;

	this.pathToSave = config["pathToSave"] || config["patchToSave"] || false;
	if (this.pathToSave) {
		try {
			this.fs.statSync(this.pathToSave);
		} catch (e) {
			try {
				this.fs.statSync("/tmp/");
				this.pathToSave = "/tmp/";
			} catch (e) {
				this.pathToSave = false;
			}
		}
	}

	// change old filename from .txt to .csv
	this.fs.rename(this.pathToSave + this.filename + "_temp.txt", this.pathToSave + this.filename + "_temperature.csv", function(err) {
		if (err) that.log('Nothing to change _hourly');
	});

	this.zeroHour = config["zeroHour"] || false;

	if (config["activityTopic"] !== undefined) {
		this.activityTopic = config["activityTopic"];
		this.activityParameter = config["activityParameter"];
	} else {
		this.activityTopic = "";
		this.activityParameter = "";
	}

	this.client_Id = "mqttjs_" + Math.random().toString(16).substr(2, 8);
	this.options = {
		keepalive: 10,
		clientId: this.client_Id,
		protocolId: "MQTT",
		protocolVersion: 4,
		clean: true,
		reconnectPeriod: 1000,
		connectTimeout: 30 * 1000,
		will: {
			topic: "WillMsg",
			payload: "Connection Closed abnormally..!",
			qos: 0,
			retain: false
		},
		username: config["username"],
		password: config["password"],
		rejectUnauthorized: false
	};

	this.lastSaveData = new Date;

	this.maxTmp = [Date(1968, 4, 29), -49.9];
	this.minTmp = [Date(1968, 4, 29), 124.9];

	this.dataMessage = {};

	this.client = mqtt.connect(this.url, this.options);

	this.client.on("error", function() {
		that.log("Error event on MQTT");
	});

	this.client.on("connect", function() {
		if (config["startCmd"] !== undefined) {
			that.client.publish(config["startCmd"], config["startParameter"] !== undefined ? config["startParameter"] : "");
		}
	});

	this.client.subscribe(this.topic);

	this.service = new Service.TemperatureSensor(this.name);

	if (this.activityTopic !== "") {
		this.client.subscribe(this.activityTopic);

		this.service.addOptionalCharacteristic(Characteristic.StatusActive);

		this.service
			.getCharacteristic(Characteristic.StatusActive)
			.on("get", this.getStatusActive.bind(this));
	}

	this.service
		.getCharacteristic(Characteristic.CurrentTemperature)
		.on("get", this.getState.bind(this));
	this.service
		.getCharacteristic(Characteristic.CurrentTemperature)
		.setProps({
			minValue: -50
		});
	this.service
		.getCharacteristic(Characteristic.CurrentTemperature)
		.setProps({
			maxValue: 125
		});

	this.Timestamp = function() {
		Characteristic.call(this, 'Time', 'FF000001-0000-1000-8000-135D67EC4377');
		this.setProps({
			format: Characteristic.Formats.STRING,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	inherits(this.Timestamp, Characteristic);
	this.service.addOptionalCharacteristic(this.Timestamp);

	this.service
		.getCharacteristic(this.Timestamp)
		.on('get', this.getTimestamp.bind(this));

	// Pressure
		this.AtmosphericPressureLevel = function() {
			Characteristic.call(this, 'Barometric Pressure', '28FDA6BC-9C2A-4DEA-AAFD-B49DB6D155AB');
	    this.setProps({
	      format:   Characteristic.Formats.UINT8,
	      unit:     "mbar",
	      minValue: 800,
	      maxValue: 1200,
	      minStep:  1,
	      perms:    [
	        Characteristic.Perms.READ,
	        Characteristic.Perms.NOTIFY
	      ]
	    });
	    this.value = this.getDefaultValue();
  	};
		inherits(this.AtmosphericPressureLevel, Characteristic);
		this.service.addOptionalCharacteristic(this.AtmosphericPressureLevel);

		this.service
			.getCharacteristic(this.AtmosphericPressureLevel)
			.on('get', this.getAtmosphericPressureLevel.bind(this));

    // Humidity
    this.CurrentRelativeHumidity = function() {
        Characteristic.call(this, 'Relative Humidity', '00000010-0000-1000-8000-0026BB765291');
        this.setProps({
            format:   Characteristic.Formats.UINT8,
            unit:     "%",
            minValue: 0,
            maxValue: 100,
            minStep:  1,
            perms:    [
                Characteristic.Perms.READ,
                Characteristic.Perms.NOTIFY
            ]
        });
        this.value = this.getDefaultValue();
    };
    inherits(this.CurrentRelativeHumidity, Characteristic);
    this.service.addOptionalCharacteristic(this.CurrentRelativeHumidity);

    this.service
        .getCharacteristic(this.CurrentRelativeHumidity)
        .on('get', this.getCurrentRelativeHumidity.bind(this));

	var that = this;

	this.client.on("message", function(topic, message) {
		if (topic == that.topic) {
		//	that.temperature = -49.9;
			try {
				that.dataMessage = JSON.parse(message);
			} catch (e) {
				that.log("JSON problem");
			}
			if (isNaN(Date.parse(that.dataMessage.Time))) {
				that.dataMessage.Time = (new Date()).toISOString;
			}
			
			if (that.dataMessage === null) {
				that.temperature = parseFloat(message);
			} else if (that.dataMessage.hasOwnProperty(that.sensorPropertyName)) {
 				that.temperature = parseFloat(that.dataMessage[that.sensorPropertyName].Temperature);
 				that.humidity = parseFloat(that.dataMessage[that.sensorPropertyName].Humidity);
            } else if (that.dataMessage.hasOwnProperty("DS18B20")) {
				that.temperature = parseFloat(that.dataMessage.DS18B20.Temperature);
                that.humidity = parseFloat(that.dataMessage.DS18B20.Humidity);
			} else if (that.dataMessage.hasOwnProperty("DHT")) {
                that.humidity = parseFloat(that.dataMessage.DHT.Humidity);
				that.temperature = parseFloat(that.dataMessage.DHT.Temperature);
			} else if (that.dataMessage.hasOwnProperty("DHT22")) {
                that.humidity = parseFloat(that.dataMessage.DHT22.Humidity);
				that.temperature = parseFloat(that.dataMessage.DHT22.Temperature);
			} else if (that.dataMessage.hasOwnProperty("AM2301")) {
                that.humidity = parseFloat(that.dataMessage.AM2301.Humidity);
				that.temperature = parseFloat(that.dataMessage.AM2301.Temperature);
			} else if (that.dataMessage.hasOwnProperty("DHT11")) {
                that.humidity = parseFloat(that.dataMessage.DHT11.Humidity);
				that.temperature = parseFloat(that.dataMessage.DHT11.Temperature);
			} else if (that.dataMessage.hasOwnProperty("HTU21")) {
                that.humidity = parseFloat(that.dataMessage.HTU21.Humidity);
				that.temperature = parseFloat(that.dataMessage.HTU21.Temperature);
			} else if (that.dataMessage.hasOwnProperty("BMP280")) {
				that.temperature = parseFloat(that.dataMessage.BMP280.Temperature);
                that.humidity = parseFloat(that.dataMessage.BMP280.Humidity);
				that.pressure = parseFloat(that.dataMessage.BMP280.Pressure);
			} else if (that.dataMessage.hasOwnProperty("BME280")) {
				that.temperature = parseFloat(that.dataMessage.BME280.Temperature);
                that.humidity = parseFloat(that.dataMessage.BME280.Humidity);
				that.pressure = parseFloat(that.dataMessage.BME280.Pressure);
			} else if (that.dataMessage.hasOwnProperty("BMP180")) {
				that.temperature = parseFloat(that.dataMessage.BMP180.Temperature);
                that.humidity = parseFloat(that.dataMessage.BMP180.Humidity);
				that.pressure = parseFloat(that.dataMessage.BMP180.Pressure);
			} else if (that.dataMessage.hasOwnProperty("SI7021")) {
                that.temperature = parseFloat(that.dataMessage.SI7021.Temperature);
                that.humidity = parseFloat(that.dataMessage.SI7021.Humidity);
            }
            else  {
				return null
			}
			if (that.temperature > -50){
				that.service.setCharacteristic(Characteristic.CurrentTemperature, that.temperature);
				that.service.setCharacteristic(that.AtmosphericPressureLevel, that.pressure);
				that.service.setCharacteristic(that.Timestamp, convertDateToStr(that.dataMessage.Time));
                that.service.setCharacteristic(Characteristic.CurrentRelativeHumidity, that.humidity);
			}
			
			// Write temperature to file
			if (that.pathToSave) {
                if (that.writeMinAndMax) {
                    var zeroDate = that.zeroHour ? (new Date()).setHours(that.zeroHour, 0, 0, 0) : false;
                    // min temp
                    if (that.temperature > -50) {
                        that.fs.readFile(that.pathToSave + that.filename + "_minTemp.txt", "utf8", function (err, data) {
                            if (err) {
                                that.minTmp = [new Date().toISOString(), that.temperature];
                                that.fs.writeFile(that.pathToSave + that.filename + "_minTemp.txt", that.minTmp.join("\t"), "utf8", function (err) {
                                    if (err) {
                                        that.pathToSave = false;
                                        that.log("Problem with save minTemp file");
                                    }
                                });
                            } else {
                                that.minTmp = data.split("\t");
                                that.log("that.minTmp po odczycie", that.minTmp);
                                if (that.minTmp.lenght < 2 || !((new Date(that.minTmp[0])).getTime() > 0)) {
                                    that.minTmp = [new Date().toISOString(), that.temperature];
                                    that.fs.writeFile(that.pathToSave + that.filename + "_minTemp.txt", that.minTmp.join("\t"), "utf8", function (err) {
                                        if (err) {
                                            that.pathToSave = false;
                                            that.log("Problem with save minTemp file");
                                        }
                                    });
                                }
                                // how old is last record?
                                if (zeroDate ? (new Date(that.minTmp[0])).getTime() - zeroDate < -86400000 : (new Date).getTime() - (new Date(that.minTmp[0])).getTime() > 86400000) {
                                    that.minTmp = [(new Date()).toISOString(), that.temperature];
                                    that.fs.writeFile(that.pathToSave + that.filename + "_minTemp.txt", that.minTmp.join("\t"), "utf8", function (err) {
                                        if (err) throw err;
                                    });
                                } else {
                                    if (that.temperature < parseFloat(that.minTmp[1])) {
                                        that.minTmp = [(new Date()).toISOString(), that.temperature];
                                        that.fs.writeFile(that.pathToSave + that.filename + "_minTemp.txt", that.minTmp.join("\t"), "utf8", function (err) {
                                            if (err) throw err;
                                        });
                                    }
                                }
                            }
                        });
                    }
                    // max temp

                    that.fs.readFile(that.pathToSave + that.filename + "_maxTemp.txt", 'utf8', function (err, data) {
                        if (err) {
                            that.maxTmp = [(new Date()).toISOString(), that.temperature];
                            that.fs.writeFile(that.pathToSave + that.filename + "_maxTemp.txt", that.maxTmp.join("\t"), "utf8", function (err) {
                                if (err) {
                                    that.pathToSave = false;
                                    that.log("Problem with save maxTemp file");
                                }
                            });
                        } else {
                            that.maxTmp = data.split("\t");
                            that.log("that.maxTmp po odczycie", that.maxTmp);
                            if (that.maxTmp.lenght < 2 || !((new Date(that.maxTmp[0])).getTime() > 0)) {
                                that.maxTmp = [(new Date()).toISOString(), that.temperature];
                                that.fs.writeFile(that.pathToSave + that.filename + "_maxTemp.txt", that.maxTmp.join("\t"), "utf8", function (err) {
                                    if (err) {
                                        that.pathToSave = false;
                                        that.log("Problem with save mmaxTemp file");
                                    }
                                });
                            }
                            // how old is last record?
                            if (zeroDate ? (new Date(that.maxTmp[0])).getTime() - zeroDate < -86400000 : (new Date).getTime() - (new Date(that.maxTmp[0])).getTime() > 86400000) {
                                that.maxTmp = [(new Date()).toISOString(), that.temperature];
                                that.fs.writeFile(that.pathToSave + that.filename + "_maxTemp.txt", that.maxTmp.join("\t"), "utf8", function (err) {
                                    if (err) throw err;
                                });
                            } else {
                                if (that.temperature > parseFloat(that.maxTmp[1])) {
                                    that.maxTmp = [(new Date()).toISOString(), that.temperature];
                                    that.fs.writeFile(that.pathToSave + that.filename + "_maxTemp.txt", that.maxTmp.join("\t"), "utf8", function (err) {
                                        if (err) throw err;
                                    });
                                }
                            }
                        }
                    });
                }
            }
		} else if (topic == that.activityTopic) {
			var status = message.toString();
			that.activeStat = (status == that.activityParameter);
			that.service.setCharacteristic(Characteristic.StatusActive, that.activeStat);
		}
	});

	
	// Save data periodically
	if (this.savePeriod > 0) {
		that.log("Saving data every " + this.savePeriod + " minutes to " + that.pathToSave);
		
		//VPD
		
		let asvp = Math.pow(610.78 * Math.E , (that.temperature / (that.temperature +238.3) * 17.2694));
		
		let LSVP = Math.pow(610.78 * Math.E , ((that.temperature-2) / ((that.temperature-2) +238.3) * 17.2694));
		
		let VPD = LSVP - (asvp * (that.humidity) / 100);
		

		
		
		var j = schedule.scheduleJob("0 */" + this.savePeriod + " * * * *", function() {
			that.log("Saving data to " + that.pathToSave + "(temp=" + that.temperature + ", pressure=" + that.pressure + ", humidity=" + that.humidity + " vpd="+ VPD +")");

			if (this.singleFile) {
                let text = convertDateToStr(that.dataMessage.Time) + "\t" + that.temperature;
                if (that.pressure > 800) { text = text + "\t" + that.pressure }
				if (that.humidity > 0) { text = text + "\t" + that.humidity }
				if(VPD>0){ text=text+"\t"+VPD}
				text = text + "\n";
                that.fs.appendFile(that.pathToSave + that.filename + "_log.csv", text, "utf8", function (err) {
                    if (err) {
                        that.pathToSave = false;
                        that.log("Problem with save file (temperature log)");
                    }
                });
			}
			else {
                that.fs.appendFile(that.pathToSave + that.filename + "_temperature.csv", convertDateToStr(that.dataMessage.Time) + "\t" + that.temperature + "\n", "utf8", function (err) {
                    if (err) {
                        that.pathToSave = false;
                        that.log("Problem with save file (temperature log)");
                    }
                });
                if (that.pressure > 800) {
                    that.fs.appendFile(that.pathToSave + that.filename + "_pressure.csv", convertDateToStr(that.dataMessage.Time) + "\t" + that.pressure + "\n", "utf8", function (err) {
                        if (err) {
                            that.pathToSave = false;
                            that.log("Problem with save file (_pressure log)");
                        }
                    });
                }
                if (that.humidity > 0) {
                    that.fs.appendFile(that.pathToSave + that.filename + "_humidity.csv", convertDateToStr(that.dataMessage.Time) + "\t" + that.humidity + "\n", "utf8", function (err) {
                        if (err) {
                            that.pathToSave = false;
                            that.log("Problem with save file (_humidity log)");
                        }
                    });
                }
                
                
                              
                if (VPD > 0) {
                	that.fs.appendFile(that.pathToSave + that.filename + "_vpd.csv", convertDateToStr(that.dataMessage.Time) + "\t" + VPD + "\n", "utf8", function (err) {
                		if (err) {
                			that.pathToSave = false;
                			that.log("Problem with save file (_vpd log)");
                		}
                	});
                }

                
            }
		});
	}
	// Roll temp. files mothly
	var i = schedule.scheduleJob("0 0 1 * *", function() {
		that.fs.rename(that.pathToSave + that.filename + "_temperature.csv", that.pathToSave + that.filename + "_temperature_" + convertDateTofilename(Date()) + ".csv", function(err) {
			if (err) that.log('ERROR change filename: ' + err);
		});
		that.fs.rename(that.pathToSave + that.filename + "_pressure.csv", that.pathToSave + that.filename + "_pressure_" + convertDateTofilename(Date()) + ".csv", function(err) {
			if (err) that.log('ERROR change filename: ' + err);
		});
        that.fs.rename(that.pathToSave + that.filename + "_humidity.csv", that.pathToSave + that.filename + "_humidity_" + convertDateTofilename(Date()) + ".csv", function(err) {
            if (err) that.log('ERROR change filename: ' + err);
        });
        that.fs.rename(that.pathToSave + that.filename + "_log.csv", that.pathToSave + that.filename + "_log_" + convertDateTofilename(Date()) + ".csv", function(err) {
            if (err) that.log('ERROR change filename: ' + err);
        });
	});
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getState = function(callback) {
	callback(null, this.temperature);
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getStatusActive = function(callback) {
	callback(null, this.activeStat);
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getTimestamp = function(callback) {
	callback(null, convertDateToStr(this.dataMessage.Time));
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getAtmosphericPressureLevel = function(callback) {
	callback(null, this.pressure);
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getCurrentRelativeHumidity = function(callback) {
	callback(null, this.humidity);
}

TemperatureHumidityVPDLogTasmotaAccessory.prototype.getServices = function() {

	var informationService = new Service.AccessoryInformation();

	informationService
		.setCharacteristic(Characteristic.Name, this.name)
		.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
		.setCharacteristic(Characteristic.Model, this.model)
		.setCharacteristic(Characteristic.SerialNumber, this.serialNumberMAC);

	return [informationService, this.service];
}
