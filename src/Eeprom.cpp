// src/Eeprom.cpp — EEPROM emulation backed by LittleFS InternalFS.

#include "Eeprom.h"
#include <Arduino.h>
#include <InternalFileSystem.h>

using namespace Adafruit_LittleFS_Namespace;

namespace rlr { namespace eeprom {

static const char* EEPROM_FILE = "/eeprom.dat";
static uint8_t s_buf[EEPROM_SIZE];
static bool s_initialized = false;

bool init() {
    // Read existing file or create with 0xFF fill
    File f(InternalFS);
    if (f.open(EEPROM_FILE, FILE_O_READ)) {
        size_t n = f.read(s_buf, EEPROM_SIZE);
        f.close();
        // If file is shorter than EEPROM_SIZE, fill remainder with 0xFF
        if (n < EEPROM_SIZE) {
            memset(s_buf + n, 0xFF, EEPROM_SIZE - n);
        }
        Serial.print("EEPROM: loaded ");
        Serial.print(n);
        Serial.println(" bytes from flash");
    } else {
        // First boot — create blank EEPROM
        memset(s_buf, 0xFF, EEPROM_SIZE);
        commit();
        Serial.println("EEPROM: created new blank EEPROM file");
    }
    s_initialized = true;
    return true;
}

size_t read(uint16_t addr, uint8_t* buf, size_t len) {
    if (addr >= EEPROM_SIZE) return 0;
    if (addr + len > EEPROM_SIZE) len = EEPROM_SIZE - addr;
    memcpy(buf, s_buf + addr, len);
    return len;
}

size_t write(uint16_t addr, const uint8_t* buf, size_t len) {
    if (addr >= EEPROM_SIZE) return 0;
    if (addr + len > EEPROM_SIZE) len = EEPROM_SIZE - addr;
    memcpy(s_buf + addr, buf, len);
    commit();
    return len;
}

uint8_t read_byte(uint16_t addr) {
    if (addr >= EEPROM_SIZE) return 0xFF;
    return s_buf[addr];
}

void write_byte(uint16_t addr, uint8_t val) {
    if (addr >= EEPROM_SIZE) return;
    s_buf[addr] = val;
    commit();
}

void commit() {
    File f(InternalFS);
    if (f.open(EEPROM_FILE, FILE_O_WRITE)) {
        f.seek(0);
        f.write(s_buf, EEPROM_SIZE);
        f.close();
    } else {
        Serial.println("EEPROM: failed to write backing file");
    }
}

}} // namespace rlr::eeprom
