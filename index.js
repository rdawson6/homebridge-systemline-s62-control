var net = require("net");

var PLUGIN_NAME   = "homebridge-systemline-s62-control";
var PLATFORM_NAME = "SystemlineS62";

/* =============================================================================
   Plugin registration
   ============================================================================= */
module.exports = function(homebridge) {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SystemlineS62Platform);
};

/* =============================================================================
   Platform

   Config shape:
   {
     "platform": "SystemlineS62",
     "name": "Systemline S6.2",
     "host": "192.168.4.200",
     "port": 4999,
     "sources": [
       { "id": 1, "name": "Sky Q Mini" },
       { "id": 2, "name": "Sky Q" },
       { "id": 6, "name": "Apple TV" }
     ],
     "zones": [
       { "id": 1, "name": "Bedroom 1" },
       { "id": 2, "name": "Kitchen" },
       ...
     ]
   }

   Each zone becomes a HomeKit TV accessory with:
   - Power on/off  (zone srcoff / restore last source)
   - Source picker (TV input selector)
   - Volume slider (Lightbulb brightness, linked to TV)
   - Volume buttons (TelevisionSpeaker, for TV remote UI)
   ============================================================================= */
function SystemlineS62Platform(log, config, api) {
  this.log      = log;
  this.config   = config;
  this.api      = api;
  this.host      = config.host;
  this.port      = parseInt(config.port) || 4999;
  this.sources   = config.sources || [];
  this.zones     = config.zones   || [];
  this.maxVolume = parseInt(config.maxVolume) || 25;  // S6.2 max is 30; lower = finer slider control

  // Shared serial queue — one socket open at a time
  this._queue   = [];
  this._busy    = false;

  // Cached accessories restored by configureAccessory()
  this._accessories = [];

  var self = this;

  if (!api) {
    log("WARNING: Homebridge API not available.");
    return;
  }

  api.on("didFinishLaunching", function() {
    self._registerZones();
  });
}

/* Called by Homebridge for each cached accessory on startup */
SystemlineS62Platform.prototype.configureAccessory = function(accessory) {
  this._accessories.push(accessory);
};

/* =============================================================================
   Zone registration
   ============================================================================= */
SystemlineS62Platform.prototype._registerZones = function() {
  var self = this;
  var api  = this.api;

  if (this.zones.length === 0) {
    this.log("WARNING: No zones configured.");
    return;
  }
  if (this.sources.length === 0) {
    this.log("WARNING: No sources configured.");
    return;
  }

  this.log("Registering " + this.zones.length + " zones with " + this.sources.length + " sources.");

  var toRegister = [];

  for (var i = 0; i < this.zones.length; i++) {
    var zoneConfig = this.zones[i];
    var zoneId     = parseInt(zoneConfig.id);
    var zoneName   = zoneConfig.name || ("Zone " + zoneId);
    var uuid       = api.hap.uuid.generate(this.host + "-zone-" + zoneId);

    var accessory = this._accessories.find(function(a) { return a.UUID === uuid; });
    var isNew     = false;

    if (!accessory) {
      accessory          = new api.platformAccessory(zoneName, uuid);
      accessory.category = api.hap.Categories.TELEVISION;
      isNew              = true;
    }

    // Ensure context exists
    if (!accessory.context.zones) accessory.context.zones = {};
    if (!accessory.context.zones[zoneId]) {
      accessory.context.zones[zoneId] = {
        cachedActive:      null,  // bool | null
        cachedSourceIndex: null,  // 0-based index into this.sources | null
        cachedVolume:      null,  // 0-30 | null
        debounceTimer:     null
      };
    }

    this._configureZoneAccessory(accessory, zoneId, zoneName, i);

    if (isNew) {
      toRegister.push(accessory);
    } else {
      api.updatePlatformAccessories([accessory]);
    }
  }

  if (toRegister.length > 0) {
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
  }
};

/* =============================================================================
   Zone accessory configuration
   ============================================================================= */
SystemlineS62Platform.prototype._configureZoneAccessory = function(accessory, zoneId, zoneName, zoneIndex) {
  var self           = this;
  var api            = this.api;
  var Service        = api.hap.Service;
  var Characteristic = api.hap.Characteristic;

  // ── Accessory Information ──────────────────────────────────────────────────
  var infoService = accessory.getService(Service.AccessoryInformation)
    || accessory.addService(Service.AccessoryInformation);

  infoService
    .setCharacteristic(Characteristic.Manufacturer, "Systemline")
    .setCharacteristic(Characteristic.Model, "S6.2")
    .setCharacteristic(Characteristic.SerialNumber, "Zone-" + zoneId);

  // ── Television ─────────────────────────────────────────────────────────────
  var tvService = accessory.getService(Service.Television)
    || accessory.addService(Service.Television, zoneName, "television");

  tvService
    .setCharacteristic(Characteristic.ConfiguredName, zoneName)
    .setCharacteristic(
      Characteristic.SleepDiscoveryMode,
      Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
    );

  tvService
    .getCharacteristic(Characteristic.Active)
    .on("get", function(callback) { self._getActive(zoneId, accessory, callback); })
    .on("set", function(value, callback) { self._setActive(zoneId, value, accessory, callback); });

  tvService
    .getCharacteristic(Characteristic.ActiveIdentifier)
    .on("get", function(callback) { self._getActiveIdentifier(zoneId, accessory, callback); })
    .on("set", function(value, callback) { self._setActiveIdentifier(zoneId, value, accessory, callback); });

  tvService
    .getCharacteristic(Characteristic.RemoteKey)
    .on("set", function(value, callback) { self._handleRemoteKey(zoneId, value, accessory, callback); });

  // ── Input sources ──────────────────────────────────────────────────────────
  for (var i = 0; i < this.sources.length; i++) {
    var source      = this.sources[i];
    var subtype     = "input-" + source.id;
    var inputService = accessory.getServiceById(Service.InputSource, subtype)
      || accessory.addService(Service.InputSource, source.name, subtype);

    inputService
      .setCharacteristic(Characteristic.Identifier, i)
      .setCharacteristic(Characteristic.ConfiguredName, source.name)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI)
      .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

    tvService.addLinkedService(inputService);
  }

  // ── Television Speaker (volume buttons in TV remote UI) ───────────────────
  var speakerService = accessory.getService(Service.TelevisionSpeaker)
    || accessory.addService(Service.TelevisionSpeaker);

  speakerService
    .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
    .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

  speakerService
    .getCharacteristic(Characteristic.VolumeSelector)
    .on("set", function(value, callback) {
      var delta = (value === Characteristic.VolumeSelector.DECREMENT) ? -1 : 1;
      self._adjustVolume(zoneId, delta, accessory, callback);
    });

  speakerService
    .getCharacteristic(Characteristic.Mute)
    .on("get", function(callback) { self._getMute(zoneId, accessory, callback); })
    .on("set", function(value, callback) { self._setMute(zoneId, value, accessory, callback); });

  speakerService
    .getCharacteristic(Characteristic.Volume)
    .on("get", function(callback) { self._getVolumePct(zoneId, accessory, callback); })
    .on("set", function(value, callback) { self._setVolumePct(zoneId, value, accessory, callback); });

  tvService.addLinkedService(speakerService);

  // ── Lightbulb volume slider ────────────────────────────────────────────────
  // The Home app doesn't show a slider for TelevisionSpeaker volume.
  // A Lightbulb linked to the TV gives a brightness slider = volume (0-100%).
  var volSubtype  = "volume-" + zoneId;
  var volService  = accessory.getServiceById(Service.Lightbulb, volSubtype)
    || accessory.addService(Service.Lightbulb, zoneName + " Volume", volSubtype);

  volService
    .getCharacteristic(Characteristic.On)
    .on("get", function(callback) {
      var ctx = accessory.context.zones[zoneId];
      if (ctx.cachedVolume !== null) return callback(null, ctx.cachedVolume > 0);
      self._getMute(zoneId, accessory, function(err, muted) {
        callback(null, !muted);
      });
    })
    .on("set", function(value, callback) {
      self._setMute(zoneId, !value, accessory, callback);
    });

  volService
    .getCharacteristic(Characteristic.Brightness)
    .on("get", function(callback) { self._getVolumePct(zoneId, accessory, callback); })
    .on("set", function(value, callback) { self._setVolumePct(zoneId, value, accessory, callback); });

  tvService.addLinkedService(volService);

  // ── Startup query — staggered per zone ────────────────────────────────────
  setTimeout(function() {
    self._startupQuery(zoneId, accessory, tvService, volService);
  }, zoneIndex * 1500);
};

/* =============================================================================
   Startup query
   Fetches source and volume for a zone, populates cache, pushes to HomeKit.
   ============================================================================= */
SystemlineS62Platform.prototype._startupQuery = function(zoneId, accessory, tvService, volService) {
  var self           = this;
  var Characteristic = this.api.hap.Characteristic;
  var ctx            = accessory.context.zones[zoneId];

  self.log("[Zone " + zoneId + "] Startup query");

  // Query source
  self._enqueue(self._cmdGetSource(zoneId), function(err, response) {
    if (err) return;
    var isOn = response && !response.includes("srcoff");
    ctx.cachedActive = isOn;
    tvService.getCharacteristic(Characteristic.Active)
      .updateValue(isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);

    if (isOn) {
      var match = response.match(/\$r\d+src(\d+)/);
      if (match) {
        var idx = self._sourceIdToIndex(parseInt(match[1]));
        if (idx >= 0) {
          ctx.cachedSourceIndex = idx;
          tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(idx);
        }
      }
    }
  });

  // Query volume
  self._enqueue(self._cmdGetVolume(zoneId), function(err, response) {
    if (err) return;
    if (response && response.includes("volmute")) {
      ctx.cachedVolume = 0;
      volService.getCharacteristic(Characteristic.Brightness).updateValue(0);
      volService.getCharacteristic(Characteristic.On).updateValue(false);
      return;
    }
    var match = response && response.match(/\$r\d+vol(\d+)/);
    if (match) {
      ctx.cachedVolume = parseInt(match[1]);
      var pct = Math.round(ctx.cachedVolume * 100 / self.maxVolume);
      volService.getCharacteristic(Characteristic.Brightness).updateValue(pct);
      volService.getCharacteristic(Characteristic.On).updateValue(ctx.cachedVolume > 0);
      self.log("[Zone " + zoneId + "] Ready: src=" + (ctx.cachedSourceIndex !== null ? ctx.cachedSourceIndex : "?") + " vol=" + ctx.cachedVolume + "/" + self.maxVolume + " active=" + ctx.cachedActive);
    }
  });
};

/* =============================================================================
   S6.2 RS232 command builders
   ============================================================================= */
SystemlineS62Platform.prototype._cmdSetSource  = function(z, s) { return "$s" + z + "src" + s + "\r"; };
SystemlineS62Platform.prototype._cmdZoneOff    = function(z)    { return "$s" + z + "srcoff\r"; };
SystemlineS62Platform.prototype._cmdGetSource  = function(z)    { return "$g" + z + "src\r"; };
SystemlineS62Platform.prototype._cmdSetVolume  = function(z, v) { return "$s" + z + "vol" + v + "\r"; };
SystemlineS62Platform.prototype._cmdGetVolume  = function(z)    { return "$g" + z + "vol\r"; };
SystemlineS62Platform.prototype._cmdMute       = function(z)    { return "$s" + z + "volmute\r"; };
SystemlineS62Platform.prototype._cmdUnmute     = function(z)    { return "$s" + z + "volmoff\r"; };

/* =============================================================================
   Serial queue
   One TCP socket open at a time. Every command is sent doubled — the iTach
   IP2SL executes the first copy and responds to the second.
   ============================================================================= */
SystemlineS62Platform.prototype._enqueue = function(command, callback) {
  this._queue.push({ command: command, callback: callback });
  this._drain();
};

SystemlineS62Platform.prototype._drain = function() {
  if (this._busy || this._queue.length === 0) return;
  var self = this;
  var item = this._queue.shift();
  this._busy = true;
  this._send(item.command, function(err, response) {
    self._busy = false;
    item.callback(err, response);
    setTimeout(function() { self._drain(); }, 100);
  });
};

SystemlineS62Platform.prototype._send = function(command, callback) {
  var self      = this;
  var sock      = new net.Socket();
  var responded = false;

  sock.connect(this.port, this.host, function() {
    self.log("TX: " + command.trim() + " (doubled)");
    sock.write(command + command);
  });

  sock.on("data", function(data) {
    if (responded) return;
    responded = true;
    var response = data.toString().trim();
    self.log("RX: " + response);
    sock.destroy();
    callback(response.includes("Error") ? new Error("S6.2: " + response) : null, response);
  });

  sock.on("error", function(err) {
    if (responded) return;
    responded = true;
    self.log("Socket error: " + err.message);
    sock.destroy();
    callback(err);
  });

  sock.setTimeout(3000, function() {
    if (responded) return;
    responded = true;
    self.log("Socket timeout");
    sock.destroy();
    callback(new Error("Timeout"));
  });
};

/* =============================================================================
   Source index helpers
   ============================================================================= */
SystemlineS62Platform.prototype._sourceIdToIndex = function(sourceId) {
  for (var i = 0; i < this.sources.length; i++) {
    if (parseInt(this.sources[i].id) === parseInt(sourceId)) return i;
  }
  return -1;
};

SystemlineS62Platform.prototype._indexToSourceId = function(index) {
  return (index >= 0 && index < this.sources.length)
    ? parseInt(this.sources[index].id)
    : null;
};

/* =============================================================================
   Characteristic handlers
   ============================================================================= */

/* Active (power) — return cache only, never query on get */
SystemlineS62Platform.prototype._getActive = function(zoneId, accessory, callback) {
  var Characteristic = this.api.hap.Characteristic;
  var ctx = accessory.context.zones[zoneId];
  // Return cached value — startup query populates this. Default inactive until known.
  var isOn = (ctx.cachedActive === true);
  callback(null, isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
};

SystemlineS62Platform.prototype._setActive = function(zoneId, value, accessory, callback) {
  var Characteristic = this.api.hap.Characteristic;
  var ctx = accessory.context.zones[zoneId];

  if (value === Characteristic.Active.INACTIVE) {
    this.log("[Zone " + zoneId + "] Off");
    this._enqueue(this._cmdZoneOff(zoneId), function(err) {
      if (!err) ctx.cachedActive = false;
      callback(err || null);
    });
  } else {
    var idx      = (ctx.cachedSourceIndex !== null) ? ctx.cachedSourceIndex : 0;
    var sourceId = this._indexToSourceId(idx) || parseInt(this.sources[0].id);
    this.log("[Zone " + zoneId + "] On → src" + sourceId);
    this._enqueue(this._cmdSetSource(zoneId, sourceId), function(err) {
      if (!err) ctx.cachedActive = true;
      callback(err || null);
    });
  }
};

/* ActiveIdentifier (source selection) — return cache only */
SystemlineS62Platform.prototype._getActiveIdentifier = function(zoneId, accessory, callback) {
  var ctx = accessory.context.zones[zoneId];
  callback(null, ctx.cachedSourceIndex !== null ? ctx.cachedSourceIndex : 0);
};

SystemlineS62Platform.prototype._setActiveIdentifier = function(zoneId, value, accessory, callback) {
  var sourceId = this._indexToSourceId(value);
  if (!sourceId) return callback(null);
  var ctx = accessory.context.zones[zoneId];
  this.log("[Zone " + zoneId + "] Source → " + this.sources[value].name + " (src" + sourceId + ")");
  this._enqueue(this._cmdSetSource(zoneId, sourceId), function(err) {
    if (!err) { ctx.cachedSourceIndex = value; ctx.cachedActive = true; }
    callback(err || null);
  });
};

/* RemoteKey */
SystemlineS62Platform.prototype._handleRemoteKey = function(zoneId, value, accessory, callback) {
  var Characteristic = this.api.hap.Characteristic;
  if (value === Characteristic.RemoteKey.ARROW_UP) {
    this._adjustVolume(zoneId, 1, accessory, callback);
  } else if (value === Characteristic.RemoteKey.ARROW_DOWN) {
    this._adjustVolume(zoneId, -1, accessory, callback);
  } else {
    callback(null);
  }
};

/* Mute — return cache only */
SystemlineS62Platform.prototype._getMute = function(zoneId, accessory, callback) {
  var ctx = accessory.context.zones[zoneId];
  callback(null, ctx.cachedVolume === 0);
};

SystemlineS62Platform.prototype._setMute = function(zoneId, value, accessory, callback) {
  var self = this;
  var ctx  = accessory.context.zones[zoneId];
  var cmd  = value ? this._cmdMute(zoneId) : this._cmdUnmute(zoneId);
  this.log("[Zone " + zoneId + "] " + (value ? "Mute" : "Unmute"));
  this._enqueue(cmd, function(err) {
    if (!err) ctx.cachedVolume = value ? 0 : null;
    callback(err || null);
  });
};

/* Volume percentage — return cache only */
SystemlineS62Platform.prototype._getVolumePct = function(zoneId, accessory, callback) {
  var ctx = accessory.context.zones[zoneId];
  var pct = ctx.cachedVolume !== null ? Math.round(ctx.cachedVolume * 100 / this.maxVolume) : 0;
  callback(null, Math.min(100, pct));  // cap at 100% in case vol exceeds maxVolume
};

SystemlineS62Platform.prototype._setVolumePct = function(zoneId, value, accessory, callback) {
  var self   = this;
  var ctx    = accessory.context.zones[zoneId];
  var s62vol = Math.round(value * this.maxVolume / 100);

  // Respond to HomeKit immediately — never block the UI
  callback(null);

  ctx.cachedVolume = s62vol;

  if (ctx.debounceTimer) { clearTimeout(ctx.debounceTimer); ctx.debounceTimer = null; }
  ctx.debounceTimer = setTimeout(function() {
    ctx.debounceTimer = null;
    self.log("[Zone " + zoneId + "] Volume → " + s62vol + "/" + self.maxVolume + " (" + value + "%) [debounced]");
    self._enqueue(self._cmdSetVolume(zoneId, s62vol), function(err) {
      if (err) { self.log("[Zone " + zoneId + "] Volume set failed: " + err.message); ctx.cachedVolume = null; }
    });
  }, 400);
};

/* Adjust volume by ±1 step */
SystemlineS62Platform.prototype._adjustVolume = function(zoneId, delta, accessory, callback) {
  var self = this;
  var ctx  = accessory.context.zones[zoneId];

  function applyDelta(current) {
    var newVol = Math.max(0, Math.min(self.maxVolume, current + delta));
    ctx.cachedVolume = newVol;
    self.log("[Zone " + zoneId + "] Volume " + (delta > 0 ? "▲" : "▼") + " → " + newVol + "/" + self.maxVolume);
    self._enqueue(self._cmdSetVolume(zoneId, newVol), function(err) {
      callback(err || null);
    });
  }

  if (ctx.cachedVolume !== null) {
    applyDelta(ctx.cachedVolume);
  } else {
    self._enqueue(self._cmdGetVolume(zoneId), function(err, response) {
      if (err) return callback(null);
      var match = response && response.match(/\$r\d+vol(\d+)/);
      applyDelta(match ? parseInt(match[1]) : 15);
    });
  }
};
