#pragma once
// src/Config.h — minimal runtime config for RNode firmware.
// Radio parameters are set by the host via KISS commands and
// persisted in EEPROM, not in this struct. This struct exists
// only to satisfy Radio.cpp's begin(const Config&) interface.

#include <stdint.h>

namespace rlr {

struct Config {
    uint32_t freq_hz;
    uint32_t bw_hz;
    uint8_t  sf;
    uint8_t  cr;
    int8_t   txp_dbm;
    uint8_t  flags;
};

enum : uint8_t {
    CONFIG_FLAG_HEARTBEAT = 1 << 2,
};

} // namespace rlr
