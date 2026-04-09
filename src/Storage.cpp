// src/Storage.cpp — mount the internal LittleFS filesystem.
// Used by the EEPROM emulation module for persistent storage.

#include "Storage.h"
#include <Arduino.h>
#include <InternalFileSystem.h>

namespace rlr { namespace storage {

bool init() {
    Serial.println("Storage: initializing InternalFS...");
    InternalFS.begin();
    Serial.println("Storage: InternalFS mounted");
    return true;
}

}} // namespace rlr::storage
