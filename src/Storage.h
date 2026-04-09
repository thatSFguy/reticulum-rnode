#pragma once
// src/Storage.h — mount the internal LittleFS filesystem.
// Used by the EEPROM emulation module for persistent storage.

namespace rlr { namespace storage {

bool init();

}} // namespace rlr::storage
