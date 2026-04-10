// src/Ble.cpp — BLE module with Nordic UART Service (NUS).

#include "Ble.h"

#if HAS_BLE

#include <Arduino.h>
#include <bluefruit.h>

namespace rlr { namespace ble {

static BLEUart s_ble_uart;
static BLEDis  s_ble_dis;
static bool    s_connected = false;

static void _connect_callback(uint16_t conn_handle) {
    (void)conn_handle;
    s_connected = true;
    Serial.println("BLE: central connected");
}

static void _disconnect_callback(uint16_t conn_handle, uint8_t reason) {
    (void)conn_handle;
    (void)reason;
    s_connected = false;
    Serial.print("BLE: central disconnected, reason=0x");
    Serial.println(reason, HEX);
    // Restart advertising
    Bluefruit.Advertising.start(0);
}

void init(const char* device_name) {
    Serial.println("BLE: initializing...");

    Bluefruit.begin();
    Bluefruit.setTxPower(4);  // moderate TX power for BLE
    Bluefruit.setName(device_name);

    // Enable bonding/pairing
    Bluefruit.Periph.setConnectCallback(_connect_callback);
    Bluefruit.Periph.setDisconnectCallback(_disconnect_callback);

    // Device Information Service
    s_ble_dis.setManufacturer(BOARD_MANUFACTURER);
    s_ble_dis.setModel(BOARD_NAME);
    s_ble_dis.begin();

    // Nordic UART Service
    s_ble_uart.begin();

    // Advertising setup
    Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
    Bluefruit.Advertising.addTxPower();
    Bluefruit.Advertising.addService(s_ble_uart);
    Bluefruit.Advertising.addName();

    // Scan response for full name if it doesn't fit in advertising data
    Bluefruit.ScanResponse.addName();

    // Start advertising
    Bluefruit.Advertising.restartOnDisconnect(true);
    Bluefruit.Advertising.setInterval(32, 244);  // fast then slow (units of 0.625ms)
    Bluefruit.Advertising.setFastTimeout(30);     // 30 seconds of fast advertising
    Bluefruit.Advertising.start(0);               // 0 = advertise forever

    Serial.print("BLE: advertising as '");
    Serial.print(device_name);
    Serial.println("'");
}

bool connected() {
    return s_connected && s_ble_uart.notifyEnabled();
}

int available() {
    return s_ble_uart.available();
}

int read() {
    return s_ble_uart.read();
}

size_t write(const uint8_t* buf, size_t len) {
    if (!connected()) return 0;
    return s_ble_uart.write(buf, len);
}

size_t write(uint8_t b) {
    if (!connected()) return 0;
    return s_ble_uart.write(b);
}

}} // namespace rlr::ble

#else // !HAS_BLE

namespace rlr { namespace ble {
void init(const char*) {}
bool connected() { return false; }
int available() { return 0; }
int read() { return -1; }
size_t write(const uint8_t*, size_t) { return 0; }
size_t write(uint8_t) { return 0; }
}} // namespace rlr::ble

#endif // HAS_BLE
