// docs/dfu.js — Adafruit nRF52 serial DFU client in pure JavaScript.
//
// Implements the Nordic legacy HCI-framed DFU protocol as spoken by
// adafruit/Adafruit_nRF52_Bootloader. Ported from the proven
// reticulum-lora-repeater implementation.
//
// Dependencies: JSZip (loaded by index.html on window.JSZip).
//
// Transport model: takes a SerialPort instance that has already been
// opened at 115200 8N1 by the caller.

'use strict';

// ---------------------------------------------------------------
//  Low-level helpers — SLIP, CRC16, little-endian pack
// ---------------------------------------------------------------

function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00);
    crc ^= bytes[i];
    crc ^= (crc & 0x00FF) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00FF) << 4) << 1;
    crc &= 0xFFFF;
  }
  return crc;
}

function u32le(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

function slipEscape(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xC0)      { out.push(0xDB, 0xDC); }
    else if (b === 0xDB) { out.push(0xDB, 0xDD); }
    else                 { out.push(b); }
  }
  return out;
}

function slipUnescape(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xDB) {
      const n = bytes[++i];
      if      (n === 0xDC) out.push(0xC0);
      else if (n === 0xDD) out.push(0xDB);
      else throw new Error('SLIP: 0xDB not followed by 0xDC/0xDD');
    } else {
      out.push(b);
    }
  }
  return out;
}

// ---------------------------------------------------------------
//  HCI packet builder
// ---------------------------------------------------------------
class HciPacket {
  static sequence = 0;
  static resetSequence() { HciPacket.sequence = 0; }

  static build(payload) {
    HciPacket.sequence = (HciPacket.sequence + 1) % 8;
    const seq = HciPacket.sequence;
    const nextSeq = (seq + 1) % 8;

    const DIC = 1;
    const RP  = 1;
    const TYPE = 14;
    const len = payload.length;

    const pre = [0, 0, 0, 0];
    pre[0] = seq | (nextSeq << 3) | (DIC << 6) | (RP << 7);
    pre[1] = (TYPE & 0x0F) | ((len & 0x00F) << 4);
    pre[2] = (len & 0xFF0) >> 4;
    pre[3] = ((~(pre[0] + pre[1] + pre[2])) + 1) & 0xFF;

    const body = pre.concat(payload);
    const c = crc16(body);
    body.push(c & 0xFF, (c >> 8) & 0xFF);

    const escaped = slipEscape(body);
    return new Uint8Array([0xC0, ...escaped, 0xC0]);
  }
}

// ---------------------------------------------------------------
//  DfuPackage — parses the firmware.zip PlatformIO produces
// ---------------------------------------------------------------
class DfuPackage {
  constructor() {
    this.initPacket = null;
    this.firmware   = null;
    this.manifest   = null;
  }

  static async fromArrayBuffer(buf) {
    if (!window.JSZip) throw new Error('JSZip not loaded');
    const zip = await window.JSZip.loadAsync(buf);

    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('firmware.zip has no manifest.json');
    const manifestText = await manifestEntry.async('string');
    const manifest = JSON.parse(manifestText);

    const app = manifest && manifest.manifest && manifest.manifest.application;
    if (!app) throw new Error('manifest.json has no manifest.application');

    const binEntry = zip.file(app.bin_file);
    const datEntry = zip.file(app.dat_file);
    if (!binEntry) throw new Error('missing firmware file: ' + app.bin_file);
    if (!datEntry) throw new Error('missing init packet: '   + app.dat_file);

    const pkg = new DfuPackage();
    pkg.manifest   = manifest;
    pkg.firmware   = new Uint8Array(await binEntry.async('arraybuffer'));
    pkg.initPacket = new Uint8Array(await datEntry.async('arraybuffer'));
    return pkg;
  }

  static async fromFile(file) {
    const buf = await file.arrayBuffer();
    return DfuPackage.fromArrayBuffer(buf);
  }
}

// ---------------------------------------------------------------
//  DfuTransport
// ---------------------------------------------------------------
const DFU_INIT_PACKET      = 1;
const DFU_START_PACKET     = 3;
const DFU_DATA_PACKET      = 4;
const DFU_STOP_DATA_PACKET = 5;
const DFU_UPDATE_MODE_APP  = 4;

const FLASH_PAGE_SIZE        = 4096;
const FLASH_PAGE_ERASE_MS    = 89.7;
const DFU_PACKET_MAX_SIZE    = 512;
// Per-page write pacing, mirrored from adafruit-nrfutil's DfuTransportSerial
// (FLASH_WORD_WRITE_TIME 100 us × 1024 words/page). The per-packet ack only
// means the bootloader BUFFERED the packet; when it then blocks to erase+write
// a flash page its UART RX is unserviced and — with NO hardware flow control on
// the CDC link — incoming bytes are dropped. So after every 4 KB page (8 × 512 B
// packets) we must idle long enough for that page write to finish, or the image
// is silently corrupted and the bootloader rejects it (CRC fail → stuck in DFU).
const FLASH_WORD_WRITE_MS    = 0.1;
const FLASH_PAGE_WRITE_MS    = (FLASH_PAGE_SIZE / 4) * FLASH_WORD_WRITE_MS;  // ≈102 ms
// Generous, non-fatal ack window. The Adafruit/Nordic legacy bootloader
// is inconsistent about ack timing, so we pace on the ack but never abort
// the flash on a miss — matching adafruit-nrfutil's lenient transport.
const ACK_TIMEOUT_MS         = 2500;

class DfuTransport {
  constructor(port, logFn) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.rxBuffer = [];
    this.rxResolvers = [];
    this.readLoopPromise = null;
    this.log = logFn || (() => {});
    this.abort = false;
  }

  async open() {
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoopPromise = this._readLoop();
  }

  async close() {
    this.abort = true;
    try { if (this.reader) await this.reader.cancel(); } catch (e) {}
    try { if (this.writer) { this.writer.releaseLock(); } } catch (e) {}
    try { if (this.reader) { this.reader.releaseLock(); } } catch (e) {}
    for (const r of this.rxResolvers) { try { r.reject(new Error('closed')); } catch (e) {} }
    this.rxResolvers = [];
  }

  async _readLoop() {
    try {
      while (!this.abort) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        for (let i = 0; i < value.length; i++) this.rxBuffer.push(value[i]);
        this._drainResolvers();
      }
    } catch (e) {}
  }

  _drainResolvers() {
    while (this.rxResolvers.length > 0 && this.rxBuffer.length > 0) {
      const entry = this.rxResolvers.shift();
      entry.resolve(this.rxBuffer.shift());
    }
  }

  _readByte(deadline) {
    if (this.rxBuffer.length > 0) return Promise.resolve(this.rxBuffer.shift());
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(new Error('ack timeout')); return; }
      const timer = setTimeout(() => {
        const i = this.rxResolvers.indexOf(entry);
        if (i >= 0) this.rxResolvers.splice(i, 1);
        reject(new Error('ack timeout'));
      }, remaining);
      entry.resolve = (b) => { clearTimeout(timer); resolve(b); };
      entry.reject  = (e) => { clearTimeout(timer); reject(e); };
      this.rxResolvers.push(entry);
    });
  }

  // Drain exactly one ack frame — skip any leading 0xC0 delimiters, consume
  // the body, and stop at the closing 0xC0 — or time out. Returns true if a
  // full frame was seen, false on timeout.
  //
  // Consuming a *whole* frame (rather than just counting two 0xC0 bytes) keeps
  // the RX stream aligned: the Adafruit/Nordic bootloader often shares a single
  // 0xC0 as both the closing delimiter of one ack and the opening delimiter of
  // the next, so the old count-to-two logic drifted one boundary further into
  // the stream on each call. Over a few hundred data packets that drift let the
  // host run ahead of the bootloader and overrun its RX buffer — dropping bytes,
  // failing the final image CRC, and leaving the old app in place (the classic
  // "flash completes but nothing changed"). Still deliberately lenient: it does
  // NOT unescape or verify the body and NEVER throws.
  async readAck(timeoutMs = ACK_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    try {
      // Skip leading delimiters (and any shared boundary 0xC0 left from a prior ack).
      let b = await this._readByte(deadline);
      while (b === 0xC0) b = await this._readByte(deadline);
      // b is now the first body byte; consume the body up to the closing 0xC0.
      while (b !== 0xC0) b = await this._readByte(deadline);
      return true;
    } catch (e) {
      // per-byte timeout — fall through and report the miss
    }
    return false;
  }

  async sendHciPacket(payload, { expectAck = true, ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
    const frame = HciPacket.build(payload);
    await this.writer.write(frame);
    // Pace on the ack but never abort — a missed ack is not fatal.
    if (expectAck) await this.readAck(ackTimeoutMs);
  }

  async sendStartDfu(appSize) {
    const payload = [
      ...u32le(DFU_START_PACKET),
      ...u32le(DFU_UPDATE_MODE_APP),
      ...u32le(0),
      ...u32le(0),
      ...u32le(appSize),
    ];
    await this.sendHciPacket(payload);
    const eraseMs = (Math.floor(appSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_MS;
    await sleep(eraseMs);
  }

  async sendInitPacket(initBytes) {
    const payload = [
      ...u32le(DFU_INIT_PACKET),
      ...initBytes,
      0x00, 0x00,
    ];
    await this.sendHciPacket(payload);
  }

  async sendFirmware(firmware, onProgress) {
    const total = firmware.length;
    let sent = 0;
    let chunkIdx = 0;
    for (let i = 0; i < total; i += DFU_PACKET_MAX_SIZE) {
      const chunk = firmware.subarray(i, Math.min(i + DFU_PACKET_MAX_SIZE, total));
      const payload = [
        ...u32le(DFU_DATA_PACKET),
        ...chunk,
      ];
      await this.sendHciPacket(payload);
      sent = Math.min(i + chunk.length, total);
      chunkIdx++;
      if (onProgress) onProgress(sent, total);
      // After each completed 4 KB flash page, wait for the bootloader to finish
      // writing it before streaming the next page (see FLASH_PAGE_WRITE_MS).
      if (chunkIdx % 8 === 0) await sleep(FLASH_PAGE_WRITE_MS);
    }
    // Let the final (partial) page finish writing before STOP/activate.
    await sleep(FLASH_PAGE_WRITE_MS);
  }

  async sendStopDataPacket() {
    try {
      await this.sendHciPacket(u32le(DFU_STOP_DATA_PACKET), { ackTimeoutMs: 500 });
    } catch (e) {
      this.log('info', 'STOP ack timed out (expected — bootloader is activating)');
    }
  }
}

// ---------------------------------------------------------------
//  1200-baud touch — reboot a running app into its serial bootloader
// ---------------------------------------------------------------
// Opening the port at 1200 baud and closing it is the standard nRF52
// (and Arduino) "auto-reset into bootloader" trigger — the firmware-side
// equivalent of a double-tap reset. The board then re-enumerates in its
// Adafruit bootloader on the same Web Serial grant, so the SAME `port`
// object can be reopened at 115200 for the DFU itself. A board already in
// the bootloader simply ignores it.
async function dfuTouch(port) {
  try {
    await port.open({ baudRate: 1200 });
    await sleep(120);
    await port.close();
  } catch (e) {
    // Already in the bootloader, or the port could not be opened at 1200 —
    // either way, fall through and let the flash attempt proceed.
  }
  await sleep(1600);   // give the bootloader time to re-enumerate
}

// Reliable reboot-to-bootloader: send the KISS reset-to-DFU command
// (FEND CMD_RESET 0xDF FEND) over the open app port. The firmware resets
// itself into the Adafruit serial-DFU bootloader via the SoftDevice-safe
// GPREGRET path — unlike the 1200-baud touch, this is dependable on
// BLE-enabled boards. No-op on firmware older than v0.4.2 (the command is
// simply ignored), so callers should still run dfuTouch() as a fallback.
async function dfuRebootToBootloader(port) {
  try {
    await port.open({ baudRate: 115200 });
    const writer = port.writable.getWriter();
    // FEND=0xC0, CMD_RESET=0x55, RESET_TO_BOOTLOADER=0xDF (no escaping needed)
    await writer.write(new Uint8Array([0xC0, 0x55, 0xDF, 0xC0]));
    writer.releaseLock();
    await sleep(250);            // let the firmware receive + act on it
    await port.close();
  } catch (e) {
    // Port busy/closing or board already resetting — ignore and continue.
  }
  await sleep(300);
}

// ---------------------------------------------------------------
//  Top-level flash() entry point — owns the 115200 port lifecycle
// ---------------------------------------------------------------
async function dfuFlash(port, dfuPackage, { onStage, onProgress, log } = {}) {
  const stage = onStage || (() => {});
  const logFn = log || (() => {});

  HciPacket.resetSequence();
  // No flow control: adafruit-nrfutil's serial transport uses
  // DEFAULT_FLOW_CONTROL = False, and the Adafruit nRF52 bootloader's CDC link
  // doesn't implement RTS/CTS. Overrun is prevented by the per-page write delay
  // in sendFirmware(), not by flow control. (Requesting 'hardware' here on a
  // link that ignores it just risks the host stalling on a CTS that never comes.)
  await port.open({ baudRate: 115200 });
  const transport = new DfuTransport(port, logFn);
  try {
    await transport.open();

    stage('Sending START_DFU (app_size=' + dfuPackage.firmware.length + ')');
    await transport.sendStartDfu(dfuPackage.firmware.length);

    stage('Sending init packet (' + dfuPackage.initPacket.length + ' bytes)');
    await transport.sendInitPacket(dfuPackage.initPacket);

    stage('Streaming firmware (' + dfuPackage.firmware.length + ' bytes)');
    await transport.sendFirmware(dfuPackage.firmware, onProgress);

    stage('Sending STOP / activate');
    await transport.sendStopDataPacket();

    stage('Done — bootloader is activating');
  } finally {
    await transport.close();
    try { await port.close(); } catch (e) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

window.RLRDfu = {
  dfuFlash,
  dfuTouch,
  dfuRebootToBootloader,
  DfuPackage,
  HciPacket,
  crc16,
  slipEscape,
  slipUnescape,
};
