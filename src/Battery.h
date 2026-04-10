#pragma once
// src/Battery.h — Battery voltage reading via ADC.
// Board headers define PIN_BATTERY, BATTERY_ADC_RESOLUTION, and
// HAS_BATTERY_SENSE. Returns battery level as a percentage (0-100).

#include <stdint.h>

namespace rlr { namespace battery {

// Initialize ADC for battery reading.
void init();

// Read battery voltage in millivolts.
uint16_t read_mv();

// Return battery level as a percentage 0-100 (LiPo curve).
uint8_t level_percent();

}} // namespace rlr::battery
