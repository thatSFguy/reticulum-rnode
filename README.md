# reticulum-rnode

RNode firmware with KISS serial interface for nRF52840 + SX1262 boards. Acts as a USB-connected LoRa radio modem for [Reticulum](https://reticulum.network/)'s `RNodeInterface`.

The host runs the Reticulum stack (via `rnsd`, Sideband, or NomadNet); this firmware handles the radio.

## Supported Boards

| Board | Radio Module | Status |
|-------|-------------|--------|
| Faketec (Nice!Nano + E22-900M30S) | SX1262 + ext PA | Tested |
| RAK4631 (WisBlock Core) | SX1262 integrated | Untested |
| Seeed XIAO nRF52840 Kit | Wio-SX1262 | Untested |
| Heltec Mesh Node T114 | SX1262 integrated | Untested |
| RAK3401 1-Watt | SX1262 + 1W PA | Untested |

## Building

Requires [PlatformIO](https://platformio.org/).

```bash
# Build for a specific board
pio run -e Faketec
pio run -e RAK4631
pio run -e XIAO_nRF52840
pio run -e Heltec_T114
pio run -e RAK3401

# Flash via nrfutil (USB bootloader)
pio run -e Faketec -t upload --upload-port COMxx

# Serial monitor
pio device monitor -e Faketec --port COMxx
```

The build produces `firmware.hex`, `firmware.zip` (nrfutil DFU package), and `firmware.uf2` (for boards with UF2 bootloader like XIAO).

## Usage with Reticulum

1. Flash the firmware to your board.
2. Connect via USB. The board appears as a USB CDC serial port at 115200 baud.
3. Configure Reticulum to use `RNodeInterface`:

```ini
# ~/.reticulum/config

[interfaces]
  [[RNode LoRa]]
    type = RNodeInterface
    port = /dev/ttyACM0       # or COMxx on Windows
    frequency = 915000000
    bandwidth = 125000
    spreading_factor = 10
    coding_rate = 5
    txpower = 22
```

4. Start `rnsd` or your Reticulum application. The host will auto-detect the RNode and configure it via KISS commands.

## Provisioning with rnodeconf

The firmware supports EEPROM emulation for `rnodeconf` provisioning. The virtual EEPROM is backed by LittleFS on the nRF52840's internal flash.

```bash
rnodeconf /dev/ttyACM0 --autoinstall
```

## Webflasher

A browser-based flasher and provisioning tool is included in `webflasher/`. It uses the Web Serial API (Chrome/Edge/Opera) to:

- Flash firmware via nRF52 DFU (1200-baud touch reset)
- Provision device identity (product, model, serial, checksum) to EEPROM
- Configure radio parameters (frequency, bandwidth, SF, CR, TX power)
- Read device info, blink LED, dump EEPROM

To use it, serve the `webflasher/` directory with any static HTTP server, or open `index.html` directly. No build step required.

```bash
# Quick local server
cd webflasher && python -m http.server 8080
# Then open http://localhost:8080
```

Or deploy to GitHub Pages for zero-install access.

## Features

- Full RNode KISS protocol (CMD_DETECT, CMD_FW_VERSION, CMD_PLATFORM, radio config, CMD_DATA)
- Split-packet support for payloads > 254 bytes (RNode-compatible two-frame reassembly)
- CSMA/CA with carrier-sense before transmit
- Radio config persistence (CMD_CONF_SAVE/DELETE)
- Battery voltage reporting (CMD_STAT_BAT)
- EEPROM emulation on LittleFS (ROM_READ/ROM_WRITE for rnodeconf)
- RSSI/SNR reporting on every received packet
- TX flow control (CMD_READY)
- SPI recovery with automatic radio reset on failure
- UF2 output for drag-and-drop flashing on supported boards

## Architecture

All board differentiation is via macros in `include/board/<name>.h`. No `#ifdef BOARD_MODEL` chains in source files. Adding a new SX1262-based board requires only:

1. A new board header in `include/board/`
2. A new `[env:]` section in `platformio.ini`

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Related Projects

- [reticulum-lora-repeater](https://github.com/thatSFguy/reticulum-lora-repeater) — Same hardware, different personality: runs Reticulum on-device as an autonomous transport node.

## License

See [LICENSE](LICENSE).
