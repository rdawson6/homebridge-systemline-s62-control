# homebridge-systemline-s62

A [Homebridge](https://homebridge.io) plugin for the **Systemline S6.2** multi-room audio system. Each zone appears as a **TV accessory** in HomeKit with source selection and volume control via a **Global Cache iTach IP2SL** RS232 interface.

[![npm](https://img.shields.io/npm/v/homebridge-systemline-s62)](https://www.npmjs.com/package/homebridge-systemline-s62)
[![Homebridge v2](https://img.shields.io/badge/homebridge-%5E1.0.0%20%7C%7C%20%5E2.0.0-blueviolet)](https://homebridge.io)

> **Looking for switch-based control?** See [homebridge-globalcache-gc100-kiro](https://www.npmjs.com/package/homebridge-globalcache-gc100-kiro) which exposes zones as simple on/off switches — useful for automations that don't need source selection.

---

## Overview

The [Systemline S6.2](https://www.systemline.co.uk) is an 8-zone multi-room audio matrix amplifier with an RS232 control interface but no native IP connectivity.

This plugin bridges that gap using a [Global Cache iTach IP2SL](https://www.globalcache.com/products/itach/ip2slspecs/) — a network-to-serial adapter — to expose each S6.2 zone as a HomeKit TV accessory. You can then control your whole-home audio from the Apple Home app, Siri, or any HomeKit automation.

**What you can do from HomeKit:**
- Turn individual zones on or off
- Select the source for each zone (Sky Q, Apple TV, etc.) using the TV input picker
- Control volume per zone via a brightness slider
- Use volume up/down buttons in the TV remote UI
- Include zones in automations and scenes

---

## How it works

```
HomeKit
    ↓
Homebridge plugin (Pi)
    ↓
TCP socket → iTach IP2SL port 4999
    ↓
RS232 serial output
    ↓
Systemline S6.2
```

Each zone is a **TV accessory** containing:
- `Television` service — power on/off and source selection
- `TelevisionSpeaker` service — volume buttons in the TV remote UI
- `Lightbulb` service — brightness slider = volume (0–100% maps to S6.2 range 0–30)
- `InputSource` services — one per configured source

State is cached at startup and after every change, so HomeKit responses are instant.

---

## Requirements

- [Homebridge](https://homebridge.io) v1 or v2
- Global Cache iTach IP2SL (network-to-serial adapter)
- Systemline S6.2 multi-room amplifier
- iTach IP2SL connected to the S6.2 RS232 port and reachable on your local network

---

## iTach IP2SL serial port configuration

Configure the iTach serial port via its web UI at `http://<itach-ip>`:

| Setting | Value |
|---------|-------|
| Baud rate | **9600** |
| Data bits | **8** |
| Parity | **None** |
| Stop bits | **1** |
| Flow control | **None** |

---

## Installation

```bash
npm install -g homebridge-systemline-s62
```

Or install via the Homebridge UI plugin search.

---

## Configuration

Add the platform to your Homebridge `config.json`. The plugin is best configured via the Homebridge UI which provides a form-based editor.

```json
{
  "platform": "SystemlineS62",
  "name": "Systemline S6.2",
  "host": "192.168.1.x",
  "port": 4999,
  "sources": [
    { "id": 1, "name": "Sky Q Mini" },
    { "id": 2, "name": "Sky Q" },
    { "id": 6, "name": "Apple TV" }
  ],
  "zones": [
    { "id": 1, "name": "Bedroom 1" },
    { "id": 2, "name": "Kitchen" },
    { "id": 3, "name": "Lounge" },
    { "id": 8, "name": "Garden" }
  ]
}
```

### Configuration options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `host` | ✅ | — | IP address of the iTach IP2SL |
| `port` | | `4999` | TCP port on the iTach |
| `sources` | ✅ | — | Array of sources (see below) |
| `zones` | ✅ | — | Array of zones (see below) |

#### Sources

Define the sources connected to your S6.2 by their **S6.2 source number** (1–6) and a friendly name. Only define the sources you actually use — unused sources can be omitted.

```json
"sources": [
  { "id": 1, "name": "Sky Q Mini" },
  { "id": 2, "name": "Sky Q" },
  { "id": 6, "name": "Apple TV" }
]
```

#### Zones

Define the zones you want to control by their **S6.2 zone number** (1–8) and a friendly name.

```json
"zones": [
  { "id": 1, "name": "Bedroom 1" },
  { "id": 2, "name": "Kitchen" },
  { "id": 8, "name": "Winter Lounge" }
]
```

---

## Adding zones to HomeKit

TV accessories are registered through the main Homebridge bridge — no separate pairing needed. After restarting Homebridge, the zone accessories will appear in the **Homebridge UI → Accessories** tab. Add each one to HomeKit from there.

---

## How it works internally

The S6.2 RS232 protocol uses simple ASCII commands:

| Action | Command |
|--------|---------|
| Select source | `$s<zone>src<source>\r` |
| Zone off | `$s<zone>srcoff\r` |
| Query source | `$g<zone>src\r` |
| Set volume | `$s<zone>vol<0-30>\r` |
| Query volume | `$g<zone>vol\r` |
| Mute | `$s<zone>volmute\r` |
| Unmute | `$s<zone>volmoff\r` |

All commands are serialised through a shared queue so only one TCP socket is open at a time, preventing cross-zone response collisions. Volume changes are debounced (400ms) so dragging the slider doesn't flood the amplifier.

---

## Credits

**Systemline S6.2 RS232 protocol**
Documented in the Systemline S6.2 installation manual.

**Based on**
[homebridge-globalcache-gc100-kiro](https://github.com/rdawson6/homebridge-globalcache-gc100-kiro) — the switch-based predecessor to this plugin.

**Built with Kiro AI**
This plugin was designed and built with [Kiro](https://kiro.dev), an AI-powered development environment.

---

## License

MIT
