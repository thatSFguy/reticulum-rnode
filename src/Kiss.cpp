// src/Kiss.cpp — KISS frame encoder/decoder for RNode serial protocol.

#include "Kiss.h"
#include "Radio.h"
#include "Led.h"
#include <Arduino.h>
#include <nrf_soc.h>

#ifndef RLR_VERSION
  #define RLR_VERSION "0.1.0-dev"
#endif

namespace rlr { namespace kiss {

// ---- State -------------------------------------------------------

static constexpr size_t FRAME_BUF_SIZE = 512;
static uint8_t s_frame_buf[FRAME_BUF_SIZE];
static size_t  s_frame_len = 0;
static bool    s_in_frame  = false;
static bool    s_escape    = false;

// Current radio config (set by host commands)
static uint32_t s_freq_hz   = 0;
static uint32_t s_bw_hz     = 0;
static uint8_t  s_sf        = 0;
static uint8_t  s_cr        = 0;
static int8_t   s_txp_dbm   = 0;
static bool     s_radio_on  = false;

// Firmware version (must be >= 1.52 for Reticulum host)
static constexpr uint8_t FW_MAJ = 1;
static constexpr uint8_t FW_MIN = 52;

// Packet counters
static uint32_t s_rx_count = 0;
static uint32_t s_tx_count = 0;

// Last RX signal quality (updated by read_pending in main loop)
static float s_last_rssi = 0;
static float s_last_snr  = 0;

// ---- KISS frame encoder ------------------------------------------

void send_frame(uint8_t cmd, const uint8_t* data, size_t len) {
    Serial.write(FEND);
    Serial.write(cmd);
    for (size_t i = 0; i < len; i++) {
        if (data[i] == FEND) {
            Serial.write(FESC);
            Serial.write(TFEND);
        } else if (data[i] == FESC) {
            Serial.write(FESC);
            Serial.write(TFESC);
        } else {
            Serial.write(data[i]);
        }
    }
    Serial.write(FEND);
}

void send_byte(uint8_t cmd, uint8_t value) {
    send_frame(cmd, &value, 1);
}

void send_rx_packet(const uint8_t* data, size_t len, float rssi, float snr) {
    // RNode convention: RSSI first, SNR second, then DATA
    uint8_t rssi_byte = (uint8_t)((int)rssi + RSSI_OFFSET);
    send_byte(CMD_STAT_RSSI, rssi_byte);

    int8_t snr_raw = (int8_t)(snr * 4.0f);  // SNR * 4 as signed byte
    send_byte(CMD_STAT_SNR, (uint8_t)snr_raw);

    send_frame(CMD_DATA, data, len);
    s_rx_count++;
}

// ---- Helpers -----------------------------------------------------

static void apply_radio_config() {
    if (s_freq_hz == 0 || s_bw_hz == 0 || s_sf == 0 || s_cr == 0) return;

    rlr::Config cfg;
    cfg.freq_hz = s_freq_hz;
    cfg.bw_hz   = s_bw_hz;
    cfg.sf      = s_sf;
    cfg.cr      = s_cr;
    cfg.txp_dbm = s_txp_dbm;
    cfg.flags   = 0;

    rlr::radio::begin(cfg);
}

static void send_uint32(uint8_t cmd, uint32_t value) {
    uint8_t buf[4];
    buf[0] = (value >> 24) & 0xFF;
    buf[1] = (value >> 16) & 0xFF;
    buf[2] = (value >>  8) & 0xFF;
    buf[3] = (value >>  0) & 0xFF;
    send_frame(cmd, buf, 4);
}

// ---- Command dispatch --------------------------------------------

static void dispatch_frame(uint8_t cmd, const uint8_t* data, size_t len) {
    switch (cmd) {

    case CMD_DATA:
        // TX packet via radio
        if (s_radio_on && len > 0) {
            rlr::led::on();
            int n = rlr::radio::transmit(data, len);
            rlr::led::off();
            if (n > 0) {
                s_tx_count++;
            } else {
                send_byte(CMD_ERROR, ERROR_TXFAILED);
            }
        }
        break;

    case CMD_DETECT:
        if (len >= 1 && data[0] == DETECT_REQ) {
            send_byte(CMD_DETECT, DETECT_RESP);
        }
        break;

    case CMD_FW_VERSION:
        if (len >= 1 && data[0] == 0x00) {
            uint8_t ver[2] = { FW_MAJ, FW_MIN };
            send_frame(CMD_FW_VERSION, ver, 2);
        }
        break;

    case CMD_PLATFORM:
        if (len >= 1 && data[0] == 0x00) {
            send_byte(CMD_PLATFORM, PLATFORM_NRF52);
        }
        break;

    case CMD_MCU:
        if (len >= 1 && data[0] == 0x00) {
            send_byte(CMD_MCU, MCU_NRF52);
        }
        break;

    case CMD_BOARD:
        // Respond with board model byte from header
        #if defined(BOARD_Faketec)
            send_byte(CMD_BOARD, 0x52);
        #elif defined(BOARD_RAK4631)
            send_byte(CMD_BOARD, 0x51);
        #else
            send_byte(CMD_BOARD, 0xFF);
        #endif
        break;

    case CMD_FREQUENCY:
        if (len == 4) {
            s_freq_hz = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
                        ((uint32_t)data[2] << 8)  | (uint32_t)data[3];
            apply_radio_config();
            send_uint32(CMD_FREQUENCY, s_freq_hz);
        } else if (len >= 1 && data[0] == 0x00) {
            send_uint32(CMD_FREQUENCY, s_freq_hz);
        }
        break;

    case CMD_BANDWIDTH:
        if (len == 4) {
            s_bw_hz = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
                      ((uint32_t)data[2] << 8)  | (uint32_t)data[3];
            apply_radio_config();
            send_uint32(CMD_BANDWIDTH, s_bw_hz);
        } else if (len >= 1 && data[0] == 0x00) {
            send_uint32(CMD_BANDWIDTH, s_bw_hz);
        }
        break;

    case CMD_TXPOWER:
        if (len == 1 && data[0] != 0xFF) {
            s_txp_dbm = (int8_t)data[0];
            apply_radio_config();
            send_byte(CMD_TXPOWER, (uint8_t)s_txp_dbm);
        } else if (len >= 1 && data[0] == 0xFF) {
            send_byte(CMD_TXPOWER, (uint8_t)s_txp_dbm);
        }
        break;

    case CMD_SF:
        if (len == 1 && data[0] != 0xFF) {
            s_sf = data[0];
            apply_radio_config();
            send_byte(CMD_SF, s_sf);
        } else if (len >= 1 && data[0] == 0xFF) {
            send_byte(CMD_SF, s_sf);
        }
        break;

    case CMD_CR:
        if (len == 1 && data[0] != 0xFF) {
            s_cr = data[0];
            apply_radio_config();
            send_byte(CMD_CR, s_cr);
        } else if (len >= 1 && data[0] == 0xFF) {
            send_byte(CMD_CR, s_cr);
        }
        break;

    case CMD_RADIO_STATE:
        if (len == 1) {
            if (data[0] == 0x01) {
                // Turn radio ON
                if (s_freq_hz > 0 && s_bw_hz > 0 && s_sf > 0 && s_cr > 0) {
                    apply_radio_config();
                    rlr::radio::start_rx();
                    s_radio_on = true;
                    send_byte(CMD_RADIO_STATE, 0x01);
                } else {
                    send_byte(CMD_ERROR, ERROR_INITRADIO);
                }
            } else if (data[0] == 0x00) {
                // Turn radio OFF
                rlr::radio::stop();
                s_radio_on = false;
                send_byte(CMD_RADIO_STATE, 0x00);
            } else if (data[0] == 0xFF) {
                // Query
                send_byte(CMD_RADIO_STATE, s_radio_on ? 0x01 : 0x00);
            }
        }
        break;

    case CMD_STAT_RX:
        send_uint32(CMD_STAT_RX, s_rx_count);
        break;

    case CMD_STAT_TX:
        send_uint32(CMD_STAT_TX, s_tx_count);
        break;

    case CMD_READY:
        // Always ready (no TX queue in this implementation)
        send_byte(CMD_READY, 0x01);
        break;

    case CMD_BLINK:
        if (len >= 1) {
            for (uint8_t i = 0; i < data[0]; i++) {
                rlr::led::on();
                delay(100);
                rlr::led::off();
                delay(100);
            }
        }
        break;

    case CMD_RANDOM:
        {
            uint8_t rnd;
            sd_rand_application_vector_get(&rnd, 1);
            send_byte(CMD_RANDOM, rnd);
        }
        break;

    case CMD_RESET:
        if (len >= 1 && data[0] == 0xF8) {
            Serial.flush();
            delay(50);
            NVIC_SystemReset();
        }
        break;

    case CMD_LEAVE:
        // Host disconnecting — nothing to do
        break;

    default:
        // Unknown command — ignore silently
        break;
    }
}

// ---- KISS frame parser -------------------------------------------

void init() {
    s_frame_len = 0;
    s_in_frame  = false;
    s_escape    = false;
    s_radio_on  = false;
    Serial.println("KISS: ready");
}

void tick() {
    while (Serial.available()) {
        uint8_t c = Serial.read();

        if (c == FEND) {
            if (s_in_frame && s_frame_len > 0) {
                // End of frame — dispatch
                uint8_t cmd = s_frame_buf[0];
                dispatch_frame(cmd, s_frame_buf + 1, s_frame_len - 1);
                s_frame_len = 0;
            }
            // Start of new frame (or consecutive FENDs — both valid)
            s_in_frame = true;
            s_frame_len = 0;
            s_escape = false;
            continue;
        }

        if (!s_in_frame) continue;

        if (s_escape) {
            s_escape = false;
            if (c == TFEND) c = FEND;
            else if (c == TFESC) c = FESC;
            // else: protocol error, use byte as-is
        } else if (c == FESC) {
            s_escape = true;
            continue;
        }

        if (s_frame_len < FRAME_BUF_SIZE) {
            s_frame_buf[s_frame_len++] = c;
        }
        // else: overflow — frame will be truncated
    }
}

}} // namespace rlr::kiss
