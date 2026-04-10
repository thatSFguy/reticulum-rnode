// src/Battery.cpp — Battery voltage reading via ADC.

#include "Battery.h"
#include <Arduino.h>

namespace rlr { namespace battery {

#if HAS_BATTERY_SENSE && defined(PIN_BATTERY) && PIN_BATTERY >= 0

static bool s_initialized = false;

void init() {
    analogReference(AR_INTERNAL_3_0);  // 3.0V reference on nRF52
    analogReadResolution(BATTERY_ADC_RESOLUTION);
    s_initialized = true;
}

uint16_t read_mv() {
    if (!s_initialized) return 0;

    // Average 4 samples to reduce noise
    uint32_t sum = 0;
    for (int i = 0; i < 4; i++) {
        sum += analogRead(PIN_BATTERY);
    }
    uint32_t raw = sum / 4;

    // Convert ADC reading to millivolts.
    // With 3.0V reference and 12-bit resolution: mv = raw * 3000 / 4095
    // Most boards have a voltage divider; DEFAULT_CONFIG_BATT_MULT
    // accounts for it.
    float mv = (float)raw * 3000.0f / 4095.0f;

    #if defined(DEFAULT_CONFIG_BATT_MULT)
        mv *= DEFAULT_CONFIG_BATT_MULT;
    #endif

    return (uint16_t)mv;
}

uint8_t level_percent() {
    uint16_t mv = read_mv();
    // Simple LiPo curve approximation:
    // 4200 mV = 100%, 3700 mV = 50%, 3300 mV = 0%
    if (mv >= 4200) return 100;
    if (mv <= 3300) return 0;
    // Linear approximation between 3300-4200
    return (uint8_t)(((uint32_t)(mv - 3300) * 100) / 900);
}

#else

void init() {}
uint16_t read_mv() { return 0; }
uint8_t level_percent() { return 0; }

#endif

}} // namespace rlr::battery
