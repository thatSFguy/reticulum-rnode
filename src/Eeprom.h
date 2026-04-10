#pragma once
// src/Eeprom.h — EEPROM emulation backed by LittleFS InternalFS.
//
// Provides a contiguous 4 KB virtual EEPROM that rnodeconf can read/write
// via CMD_ROM_READ / CMD_ROM_WRITE. The backing file is
// /eeprom.dat on InternalFS. Writes are committed immediately.

#include <stdint.h>
#include <stddef.h>

namespace rlr { namespace eeprom {

constexpr size_t EEPROM_SIZE = 4096;

// Mount InternalFS (if not already mounted) and load /eeprom.dat
// into the in-memory buffer. Creates the file with 0xFF fill if
// it doesn't exist. Call after rlr::storage::init().
bool init();

// Read `len` bytes starting at `addr` into `buf`.
// Returns bytes read (clamped to EEPROM_SIZE).
size_t read(uint16_t addr, uint8_t* buf, size_t len);

// Write `len` bytes starting at `addr` from `buf`.
// Commits to flash immediately. Returns bytes written.
size_t write(uint16_t addr, const uint8_t* buf, size_t len);

// Read a single byte.
uint8_t read_byte(uint16_t addr);

// Write a single byte.
void write_byte(uint16_t addr, uint8_t val);

// Flush the entire buffer to the backing file.
void commit();

}} // namespace rlr::eeprom
