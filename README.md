# reticulum-rnode

RNode firmware with KISS serial interface for nRF52840 + SX1262 boards. Acts as a USB-connected LoRa radio modem for [Reticulum](https://reticulum.network/)'s `RNodeInterface`.

The host runs the Reticulum stack (via `rnsd`, Sideband, or NomadNet); this firmware handles the radio.

> ## ⚠️ Not recommended for real use — use RNode_Firmware_CE instead
>
> This is a from-scratch reimplementation of the RNode firmware, and it has
> **known radio bugs** that make it unreliable for actual mesh use. In testing
> against stock RNode nodes we found broken/incomplete reception of multi-frame
> (split) packets and CSMA collisions that make larger transfers (e.g. images)
> crawl or stall. Some of these are fixed in the latest commits, but the firmware
> is **not validated** and reaching on-air parity with stock RNode is a long tail
> of subtle, hard-to-test work.
>
> **For a working nRF52 RNode, use the maintained projects instead:**
> - [RNode_Firmware_CE](https://github.com/liberatedsystems/RNode_Firmware_CE) — community edition, broad nRF52 board support (RAK4631, etc.)
> - [RNode_Firmware](https://github.com/markqvist/RNode_Firmware) — upstream, by Mark Qvist
>
> Flash and provision them with [`rnodeconf`](https://github.com/markqvist/Reticulum) (`pip install rns`) or [liamcottle/rnode-flasher](https://liamcottle.github.io/rnode-flasher/). They're battle-tested and interoperate with the rest of the RNode/Reticulum ecosystem out of the box.
>
> The genuinely reusable part of this repo is the **web flasher** (`docs/`); the
> firmware itself is best treated as a learning/experimentation exercise.

## Supported Boards

| Board | Radio Module | Status |
|-------|-------------|--------|
| Faketec (Nice!Nano + E22-900M30S) | SX1262 + ext PA | Tested |
| RAK4631 (WisBlock Core) | SX1262 integrated | Tested |
| Seeed XIAO nRF52840 Kit | Wio-SX1262 | Untested |
| Heltec Mesh Node T114 | SX1262 integrated | Untested |
| RAK3401 1-Watt | SX1262 + 1W PA | Untested |
| LilyGO T-Echo | SX1262 integrated | Untested — pins from Meshtastic, not bench-validated |
| Seeed SenseCAP T1000-E | **LR1110** integrated | Untested — pins/radio from the agnostic-lora-net HAL, not bench-validated |

## Building

Requires [PlatformIO](https://platformio.org/).

```bash
# Build for a specific board
pio run -e Faketec
pio run -e RAK4631
pio run -e XIAO_nRF52840
pio run -e Heltec_T114
pio run -e RAK3401
pio run -e T-Echo
pio run -e T1000E       # Seeed SenseCAP T1000-E (LR1110)

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

## Bluetooth (BLE) Pairing

The firmware advertises itself over BLE as `RNode XXXX` (the suffix is
derived from the device's MAC address). When pairing from a phone, Android
(and iOS) will show a **PIN entry prompt** — the default PIN is:

```
123456
```

After successful pairing the device shows up in your phone's paired
devices list, and apps like Sideband can connect without further prompts.

### Changing the PIN

The PIN is stored in the device's EEPROM. To change it, connect via USB
and use the webflasher's **"Bluetooth Pairing PIN"** panel: read the
current PIN, type a new 6-digit PIN, and click **Write PIN**. You'll need
to reboot the device for the change to take effect, and re-pair from
your phone (remove the old pairing first in Android's Bluetooth settings).

It can also be changed programmatically via the KISS command `CMD_BLE_PIN`
(0x70): send a 1-byte payload `0x00` to read the current PIN, or 6 ASCII
digits to store a new one.

**Security note:** The default PIN is weak and identical across every
flashed device. If you're using BLE in an environment where pairing
hijack is a concern, change it to something unique before pairing.

## Provisioning with rnodeconf

The firmware supports EEPROM emulation for `rnodeconf` provisioning. The virtual EEPROM is backed by LittleFS on the nRF52840's internal flash.

```bash
rnodeconf /dev/ttyACM0 --autoinstall
```

## Webflasher

A browser-based flasher and provisioning tool is included in `docs/`. It uses the Web Serial API (Chrome/Edge/Opera) to:

- Flash firmware via nRF52 DFU (1200-baud touch reset)
- Provision device identity (product, model, serial, checksum) to EEPROM
- Configure radio parameters (frequency, bandwidth, SF, CR, TX power)
- Read device info, blink LED, dump EEPROM

To use it locally, serve the `docs/` directory with any static HTTP server. No build step required.

```bash
cd docs && python -m http.server 8080
# Then open http://localhost:8080
```

It's also deployed via GitHub Pages at the repo's Pages URL (Settings > Pages > Source: `/docs` from `master`).

## Features

- Full RNode KISS protocol (CMD_DETECT, CMD_FW_VERSION, CMD_PLATFORM, radio config, CMD_DATA)
- Split-packet support for payloads > 254 bytes (RNode-compatible two-frame reassembly)
- Non-blocking radio (async TX + poll-driven state machine) so LoRa airtime never starves the BLE link
- CSMA/CA with carrier-sense before transmit
- Airtime accounting with host-configurable short/long caps (CMD_ST_ALOCK / CMD_LT_ALOCK) — TX is held when over budget
- Channel-time, physical-layer, and CSMA telemetry (CMD_STAT_CHTM / CMD_STAT_PHYPRM / CMD_STAT_CSMA)
- Radio config lock (CMD_RADIO_LOCK) and implicit-header toggle (CMD_IMPLICIT)
- Radio config persistence (CMD_CONF_SAVE/DELETE)
- Battery voltage reporting (CMD_STAT_BAT)
- BLE transport with configurable pairing PIN (default `123456`, change via webflasher or CMD_BLE_PIN)
- EEPROM emulation on LittleFS (ROM_READ/ROM_WRITE for rnodeconf)
- RSSI/SNR reporting on every received packet
- TX flow control (CMD_READY)
- SPI recovery with automatic radio reset on failure
- UF2 output for drag-and-drop flashing on supported boards

## Architecture

All board differentiation is via macros in `include/board/<name>.h`. No `#ifdef BOARD_MODEL` chains in source files. Adding a new SX1262-based board requires only:

1. A new board header in `include/board/`
2. A new `[env:]` section in `platformio.ini`

Boards with a **different radio** (e.g. the LR1110 on the SenseCAP T1000-E) additionally
set `RADIO_USE_LR1110` in their header; `Radio.cpp` branches on it for the radio class,
RF-switch setup, and IRQ hook. The rest of the radio core (the RadioLib LoRa API) is shared.

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Related Projects

- [reticulum-lora-repeater](https://github.com/thatSFguy/reticulum-lora-repeater) — Same hardware, different personality: runs Reticulum on-device as an autonomous transport node.

## Acknowledgments

The BLE↔radio coexistence bug that had this firmware archived as "defective and
unmaintained" was diagnosed and fixed by **[@fanattruda-cyber](https://github.com/fanattruda-cyber)** — with a healthy dose of neural-network
assistance and, by his own account, two days and a great deal of Russian swearing.

The symptom looked like a BLE connection problem (the link dropping whenever the
LoRa radio was active), and every attempt to fix it at the BLE connection layer —
connection interval, MTU negotiation, supervision timeout — failed. He found the
real root cause: it was the **BLE NUS data path**. When a reassembled KISS frame
exceeded one BLE notification, handing it to `BLEUart::write()` in a single shot
and flushing immediately made the SoftDevice queue back-to-back notifications with
no chance to drain; under contention with the LoRa ISR the notify queue overflowed,
bytes were silently dropped, and the KISS byte stream corrupted — surfacing upstream
as Reticulum HMAC / ratchet-desync failures, the long-message ceiling, and apparent
BLE drops. The fix (`src/Ble.cpp`) chunks every BLE write to a single notification,
flushes per chunk, and yields so the SoftDevice can keep up. Fixed in **v0.5.0**.

Thank you. This firmware works because of you.

## Changelog

### v0.5.2

- **Radio RX: stop aborting the second half of split packets (firmware).** In
  continuous RX the radio keeps listening after a packet, and the two air frames
  of a >254-byte (split) packet are sent back-to-back. We were calling
  `startReceive()` after every received frame, which drops to standby and aborts
  the in-flight second half — so large/multi-frame transfers (e.g. images) never
  reassembled while single-frame messages worked. Now we stay in continuous RX
  on the success path (matching stock RNode). Also align the LoRa PHY with stock
  RNode for on-air interop: adaptive preamble (`ceil(24/symbol_time)`, min 18
  symbols, was a fixed 16) and explicit low-data-rate optimization when symbol
  time > 16 ms. Requires reflashing.
- **Serial DFU per-page write pacing (webflasher).** The flasher now idles
  ~102 ms after each 4 KB flash page (and before STOP), matching
  `adafruit-nrfutil`'s `FLASH_PAGE_WRITE_TIME`, and no longer requests hardware
  flow control (the bootloader's CDC link doesn't implement it). The previous
  5 ms gap let the host stream the next page while the bootloader was still
  blocked writing the current one — bytes were dropped, the image CRC failed,
  and the board stayed in the bootloader after flashing.

### v0.5.1

- **Webflasher DFU reliability** — the serial-DFU ack reader now consumes one
  whole frame per packet instead of counting delimiter bytes. The old logic
  drifted a frame ahead of the bootloader over a full image, overrunning it and
  silently failing the image CRC, so the flash "completed" but the old app kept
  running (most visible on RAK4631). The bootloader port also opens with
  hardware flow control when available.
- **Webflasher config UX** — all KISS commands are serialized through a lock, so
  a background read can no longer steal another command's response (the cause of
  dead clicks, `freq=0`, and stray `cmd 0x51` timeouts). ROM reads retry once,
  and TX power is highlighted red when set to 0 dBm.
- **Firmware EEPROM commits are batched** — `eeprom::write()` now defers the
  flash commit and coalesces a provisioning burst into a single write, instead
  of rewriting the whole 4 KB EEPROM per byte. That used to stall the KISS RX
  handler during identity provisioning. Pending writes flush on idle and before
  reset / DFU handoff.

### v0.5.0

- BLE↔radio coexistence fixed (see Acknowledgments); firmware un-archived.

## License

See [LICENSE](LICENSE).
