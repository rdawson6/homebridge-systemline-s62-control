# Changelog

## [1.0.1] - 2026-05-22

### Fixed
- Removed S6.2 queries from `get` characteristic handlers — all reads now return from cache only, eliminating the serial queue backlog that caused Homebridge slowdown warnings
- Startup queries still populate the cache on boot; state is updated after every `set` operation

## [1.0.0] - 2026-05-14

### Initial release
- Each S6.2 zone exposed as a HomeKit TV accessory
- Source selection via TV input picker (no switches needed)
- Volume slider via linked Lightbulb brightness characteristic
- Volume buttons via TelevisionSpeaker service (TV remote UI)
- Zone on/off restores last selected source
- State cached at startup — instant HomeKit responses after first query
- Startup queries staggered per zone to avoid hammering the S6.2
- All RS232 commands generated internally — no Base64 encoding in config
- Shared serial queue prevents cross-zone response collisions
- Volume debounced 400ms for smooth slider control
- Supports up to 8 zones and 6 sources
- Built with Kiro AI
