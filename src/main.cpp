// =====================================================================
//  reticulum-rnode / src/main.cpp
//  ------------------------------------------------------------------
//  RNode firmware with KISS interface for nRF52840 + SX1262 boards.
//  Serial-to-LoRa bridge — the host runs Reticulum via RNodeInterface,
//  this firmware handles the radio.
// =====================================================================

#include <Arduino.h>
#include "Config.h"
#include "Radio.h"
#include "Led.h"
#include "Kiss.h"

#ifndef RLR_VERSION
  #define RLR_VERSION "0.1.0-dev"
#endif

// RX buffer for radio packets (must fit reassembled split packets)
static uint8_t rx_buf[512];

void setup() {
    Serial.begin(115200);
    // Give USB CDC time to enumerate
    uint32_t wait_start = millis();
    while (!Serial && (millis() - wait_start) < 4000) {
        delay(10);
    }

    Serial.println();
    Serial.println("=====================================================");
    Serial.print("  reticulum-rnode ");
    Serial.println(RLR_VERSION);
    Serial.print("  Board: ");
    Serial.println(BOARD_NAME);
    Serial.print("  Radio: ");
    Serial.print(RADIO_CHIP);
    Serial.print(" (");
    Serial.print(RADIO_MODULE);
    Serial.println(")");
    Serial.println("  Mode: KISS RNode");
    Serial.println("=====================================================");

    rlr::led::init();

    // Initialize radio hardware (VEXT, SPI)
    if (!rlr::radio::init_hardware()) {
        Serial.println("Setup: radio::init_hardware() failed");
    }

    // Initialize KISS processor
    rlr::kiss::init();

    Serial.println("Setup complete — waiting for host KISS commands.");
}

void loop() {
    // Process incoming KISS frames from host
    rlr::kiss::tick();

    // Check for radio RX packets and send to host
    if (rlr::radio::rx_pending()) {
        int n = rlr::radio::read_pending(rx_buf, sizeof(rx_buf));
        if (n > 0) {
            rlr::led::on();
            // read_pending strips the RNode header and handles split
            // reassembly. The returned data is the raw Reticulum payload.
            // We need to get RSSI/SNR — but read_pending already consumed
            // the radio state. For now, use the values logged by Radio.cpp.
            // TODO: expose last_rssi/last_snr from Radio module
            rlr::kiss::send_rx_packet((const uint8_t*)rx_buf, n, 0, 0);
            rlr::led::off();
        }
    }

    // Heartbeat LED
    static rlr::Config s_minimal_cfg = { 0, 0, 0, 0, 0, rlr::CONFIG_FLAG_HEARTBEAT };
    rlr::led::heartbeat_tick(s_minimal_cfg);
}
