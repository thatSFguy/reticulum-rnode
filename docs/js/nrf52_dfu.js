// webflasher/js/nrf52_dfu.js — nRF52 DFU serial flasher.
//
// Implements the Adafruit nRF52 bootloader's serial DFU protocol:
//   1. Touch-reset at 1200 baud to enter DFU mode
//   2. Reconnect at 115200 baud
//   3. SLIP-framed HCI packets with CRC16 for firmware transfer
//
// Based on the protocol used by adafruit-nrfutil and the reference
// rnode-flasher (liamcottle/rnode-flasher).

// ---- DFU protocol constants --------------------------------------

const DFU_INIT_PACKET    = 0x01;
const DFU_START_PACKET   = 0x02;
const DFU_DATA_PACKET    = 0x03;
const DFU_STOP_DATA_PACKET = 0x04;

const DFU_IMAGE_TYPE_APP = 0x04;

const DATA_OBJECT_MAX_SIZE = 4096;  // page size for nRF52840
const DATA_PACKET_SIZE     = 512;   // bytes per SLIP packet

// Time estimates for progress reporting
const ERASE_TIME_PER_PAGE  = 0.0897;  // seconds
const WRITE_TIME_PER_WORD  = 0.0001;  // seconds

// SLIP framing
const SLIP_END     = 0xC0;
const SLIP_ESC     = 0xDB;
const SLIP_ESC_END = 0xDC;
const SLIP_ESC_ESC = 0xDD;

// ---- CRC16 (CCITT, used by DFU protocol) -------------------------

function crc16(data) {
    let crc = 0xFFFF;
    for (const byte of data) {
        crc = ((crc >> 8) & 0xFF) | ((crc << 8) & 0xFFFF);
        crc ^= byte;
        crc ^= (crc & 0xFF) >> 4;
        crc ^= (crc << 12) & 0xFFFF;
        crc ^= ((crc & 0xFF) << 5) & 0xFFFF;
    }
    return crc & 0xFFFF;
}

// ---- SLIP framing ------------------------------------------------

function slipEncode(data) {
    const out = [];
    for (const b of data) {
        if (b === SLIP_END) {
            out.push(SLIP_ESC, SLIP_ESC_END);
        } else if (b === SLIP_ESC) {
            out.push(SLIP_ESC, SLIP_ESC_ESC);
        } else {
            out.push(b);
        }
    }
    out.push(SLIP_END);
    return new Uint8Array(out);
}

function slipDecode(data) {
    const out = [];
    let escape = false;
    for (const b of data) {
        if (b === SLIP_END) {
            if (out.length > 0) break;
            continue;
        }
        if (escape) {
            escape = false;
            if (b === SLIP_ESC_END) out.push(SLIP_END);
            else if (b === SLIP_ESC_ESC) out.push(SLIP_ESC);
            else out.push(b);
        } else if (b === SLIP_ESC) {
            escape = true;
        } else {
            out.push(b);
        }
    }
    return new Uint8Array(out);
}

// ---- HCI packet framing -----------------------------------------

function buildHciPacket(packetType, data, seqNo) {
    // HCI packet: [seq_no | reliability | packet_type | data_integrity | payload_len_lo | payload_len_hi | payload... | crc_lo | crc_hi]
    const pktLen = data.length;
    const header = new Uint8Array(2 + pktLen);

    // Byte 0: (seq << 3) | (1 << 2) | (packetType & 0x03) — reliable, data integrity present
    header[0] = ((seqNo & 0x07) << 3) | (1 << 2) | (0x01);  // data_integrity=1
    // Byte 1: (pktLen << 0) — for our sizes, fits in one byte
    header[1] = pktLen & 0xFF;

    const packet = new Uint8Array(2 + pktLen + 2);
    packet[0] = header[0];
    packet[1] = header[1];
    packet.set(data, 2);

    // CRC16 over everything except the CRC itself
    const crc = crc16(packet.subarray(0, 2 + pktLen));
    packet[2 + pktLen] = crc & 0xFF;
    packet[2 + pktLen + 1] = (crc >> 8) & 0xFF;

    return slipEncode(packet);
}

// ---- DFU Flasher class -------------------------------------------

class NRF52DfuFlasher {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.seqNo = 0;
        this._onProgress = null;
        this._onLog = null;
    }

    _log(msg) {
        if (this._onLog) this._onLog(msg);
    }

    _progress(percent, msg) {
        if (this._onProgress) this._onProgress(percent, msg);
    }

    // Enter DFU mode by opening at 1200 baud (touch reset)
    async enterDfuMode(port) {
        this._log("Entering DFU mode (1200 baud touch reset)...");
        this._progress(0, "Entering DFU mode...");

        await port.open({ baudRate: 1200 });
        await new Promise(r => setTimeout(r, 100));
        await port.close();

        // Wait for bootloader to come up
        this._log("Waiting for bootloader (1.5s)...");
        await new Promise(r => setTimeout(r, 1500));
    }

    // Connect to the DFU bootloader
    async connectDfu(port) {
        this.port = port;
        await this.port.open({ baudRate: 115200 });
        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this.seqNo = 0;
        this._log("Connected to DFU bootloader");
    }

    async disconnectDfu() {
        if (this.reader) {
            try { await this.reader.cancel(); } catch {}
            this.reader.releaseLock();
            this.reader = null;
        }
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        if (this.port) {
            try { await this.port.close(); } catch {}
            this.port = null;
        }
    }

    // Send a DFU packet and wait for ACK
    async _sendDfuPacket(data) {
        const packet = buildHciPacket(0x01, data, this.seqNo);
        this.seqNo = (this.seqNo + 1) & 0x07;
        await this.writer.write(packet);

        // Read response (SLIP-framed)
        const response = await this._readSlipPacket(5000);
        return response;
    }

    // Read a complete SLIP packet from serial
    async _readSlipPacket(timeoutMs = 5000) {
        const buf = [];
        const deadline = Date.now() + timeoutMs;
        let gotEnd = false;

        while (Date.now() < deadline) {
            const readPromise = this.reader.read();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("DFU read timeout")), Math.max(100, deadline - Date.now()))
            );

            let result;
            try {
                result = await Promise.race([readPromise, timeoutPromise]);
            } catch {
                break;
            }

            if (result.done) break;

            for (const byte of result.value) {
                buf.push(byte);
                if (byte === SLIP_END && buf.length > 1) {
                    gotEnd = true;
                    break;
                }
            }
            if (gotEnd) break;
        }

        return slipDecode(new Uint8Array(buf));
    }

    // Flash a firmware zip file (contains manifest.json + .bin/.dat)
    async flash(port, zipData, onProgress, onLog) {
        this._onProgress = onProgress || null;
        this._onLog = onLog || null;

        // Extract zip
        this._progress(2, "Extracting firmware package...");
        this._log("Extracting firmware ZIP...");

        const zip = await JSZip.loadAsync(zipData);

        // Find manifest
        const manifestFile = zip.file("manifest.json");
        if (!manifestFile) {
            throw new Error("No manifest.json in firmware ZIP");
        }
        const manifest = JSON.parse(await manifestFile.async("string"));
        this._log("Manifest: " + JSON.stringify(manifest));

        // Get the application firmware entry
        let fwEntry = null;
        if (manifest.manifest && manifest.manifest.application) {
            fwEntry = manifest.manifest.application;
        } else {
            throw new Error("No application entry in manifest");
        }

        // Extract firmware binary and init data
        const binFile = zip.file(fwEntry.bin_file);
        const datFile = zip.file(fwEntry.dat_file);
        if (!binFile || !datFile) {
            throw new Error("Missing firmware files referenced in manifest");
        }

        const firmwareData = new Uint8Array(await binFile.async("arraybuffer"));
        const initData     = new Uint8Array(await datFile.async("arraybuffer"));

        this._log(`Firmware: ${firmwareData.length} bytes, init: ${initData.length} bytes`);
        this._progress(5, "Firmware extracted");

        // Enter DFU mode
        await this.enterDfuMode(port);

        // Reconnect to bootloader
        this._progress(10, "Connecting to bootloader...");
        await this.connectDfu(port);

        try {
            // DFU sequence
            await this._dfuSendStartPacket(firmwareData.length);
            this._progress(15, "Sending init packet...");
            await this._dfuSendInitPacket(initData);
            this._progress(20, "Sending firmware data...");
            await this._dfuSendFirmwareData(firmwareData);
            this._progress(95, "Finalizing...");
            await this._dfuSendStopPacket();
            this._progress(100, "Flash complete!");
            this._log("DFU flash complete — device will reboot");
        } finally {
            await this.disconnectDfu();
        }
    }

    async _dfuSendStartPacket(imageSize) {
        this._log("Sending DFU_START_PACKET...");
        // Start packet: [opcode, image_type, size_lo, size_mid_lo, size_mid_hi, size_hi]
        const data = new Uint8Array(1 + 4 + 4 + 4);
        data[0] = DFU_START_PACKET;
        // SoftDevice size = 0
        data[1] = 0; data[2] = 0; data[3] = 0; data[4] = 0;
        // Bootloader size = 0
        data[5] = 0; data[6] = 0; data[7] = 0; data[8] = 0;
        // Application size
        data[9]  = (imageSize >>  0) & 0xFF;
        data[10] = (imageSize >>  8) & 0xFF;
        data[11] = (imageSize >> 16) & 0xFF;
        data[12] = (imageSize >> 24) & 0xFF;

        const resp = await this._sendDfuPacket(data);
        this._log("DFU_START_PACKET acknowledged");
    }

    async _dfuSendInitPacket(initData) {
        this._log("Sending DFU_INIT_PACKET...");
        const data = new Uint8Array(1 + initData.length);
        data[0] = DFU_INIT_PACKET;
        data.set(initData, 1);
        const resp = await this._sendDfuPacket(data);
        this._log("DFU_INIT_PACKET acknowledged");

        // Wait for erase
        const numPages = Math.ceil(initData.length / DATA_OBJECT_MAX_SIZE) + 1;
        const eraseTime = numPages * ERASE_TIME_PER_PAGE;
        this._log(`Waiting ${eraseTime.toFixed(1)}s for flash erase...`);
        await new Promise(r => setTimeout(r, eraseTime * 1000));
    }

    async _dfuSendFirmwareData(firmwareData) {
        const totalBytes = firmwareData.length;
        let offset = 0;
        let packetNum = 0;
        const totalPackets = Math.ceil(totalBytes / DATA_PACKET_SIZE);

        this._log(`Sending ${totalBytes} bytes in ${totalPackets} packets...`);

        while (offset < totalBytes) {
            const chunkSize = Math.min(DATA_PACKET_SIZE, totalBytes - offset);
            const chunk = firmwareData.subarray(offset, offset + chunkSize);

            const data = new Uint8Array(1 + chunk.length);
            data[0] = DFU_DATA_PACKET;
            data.set(chunk, 1);

            await this._sendDfuPacket(data);

            offset += chunkSize;
            packetNum++;

            // Progress: 20% to 95% range for data transfer
            const pct = 20 + Math.floor((offset / totalBytes) * 75);
            this._progress(pct, `Flashing: ${offset}/${totalBytes} bytes (${Math.floor(offset/totalBytes*100)}%)`);

            // Brief yield to keep UI responsive
            if (packetNum % 10 === 0) {
                await new Promise(r => setTimeout(r, 1));
            }
        }

        this._log(`Sent all ${totalBytes} bytes`);
    }

    async _dfuSendStopPacket() {
        this._log("Sending DFU_STOP_DATA_PACKET...");
        const data = new Uint8Array([DFU_STOP_DATA_PACKET]);
        await this._sendDfuPacket(data);
        this._log("DFU_STOP_DATA_PACKET acknowledged — device rebooting");
    }
}
