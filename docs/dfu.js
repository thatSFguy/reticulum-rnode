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
const ACK_TIMEOUT_MS         = 1000;

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

  async readAck(timeoutMs = ACK_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const b = await this._readByte(deadline);
      if (b === 0xC0) break;
    }
    const raw = [];
    while (true) {
      const b = await this._readByte(deadline);
      if (b === 0xC0) break;
      raw.push(b);
    }
    if (raw.length === 0) {
      return this.readAck(Math.max(50, deadline - Date.now()));
    }
    const body = slipUnescape(raw);
    if (body.length < 1) throw new Error('ACK: empty body after unescape');
    return (body[0] >> 3) & 0x07;
  }

  async sendHciPacket(payload, { expectAck = true, ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
    const frame = HciPacket.build(payload);
    await this.writer.write(frame);
    if (expectAck) {
      try {
        await this.readAck(ackTimeoutMs);
      } catch (e) {
        throw new Error('no ack for opcode ' + payload[0] + ': ' + e.message);
      }
    }
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
      if (chunkIdx % 8 === 0) await sleep(1);
    }
    await sleep(1);
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
//  Top-level flash() entry point
// ---------------------------------------------------------------
async function dfuFlash(port, dfuPackage, { onStage, onProgress, log } = {}) {
  const stage = onStage || (() => {});
  const logFn = log || (() => {});

  HciPacket.resetSequence();
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
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

window.RLRDfu = {
  dfuFlash,
  DfuPackage,
  HciPacket,
  crc16,
  slipEscape,
  slipUnescape,
};
