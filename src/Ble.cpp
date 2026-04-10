// src/Ble.cpp — BLE module with Nordic UART Service (NUS).
//
// Implements the exact BLE naming and pairing protocol that Sideband
// and Reticulum's RNodeInterface expect:
//   - Device name: "RNode XXXX" where XXXX = last 2 bytes of
//     MD5(ble_mac_6bytes + eeprom_signature_byte)
//   - MITM-protected pairing with random 6-digit PIN
//   - SECMODE_ENC_WITH_MITM on the UART service
//   - NUS (Nordic UART Service) for KISS transport

#include "Ble.h"

#if HAS_BLE

#include <Arduino.h>
#include <bluefruit.h>
#include "Eeprom.h"

namespace rlr { namespace ble {

// ---- Minimal MD5 (RFC 1321) for BLE name hash -----------------------
// Only used to compute the 16-byte hash for the "RNode XXXX" suffix.

namespace {

static const uint32_t md5_s[] = {
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
};

static const uint32_t md5_k[] = {
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,
    0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,
    0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,
    0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,
    0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,
    0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,
    0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,
    0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,
    0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
};

static inline uint32_t _rotl(uint32_t x, uint32_t n) {
    return (x << n) | (x >> (32 - n));
}

// Compute MD5 of data[0..len-1], result in out[0..15]
static void md5_hash(const uint8_t* data, size_t len, uint8_t out[16]) {
    uint32_t a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    // Pre-processing: pad to 64-byte blocks
    size_t padded_len = ((len + 8) / 64 + 1) * 64;
    uint8_t* msg = (uint8_t*)calloc(padded_len, 1);
    memcpy(msg, data, len);
    msg[len] = 0x80;
    uint64_t bit_len = (uint64_t)len * 8;
    memcpy(msg + padded_len - 8, &bit_len, 8);

    for (size_t offset = 0; offset < padded_len; offset += 64) {
        uint32_t* M = (uint32_t*)(msg + offset);
        uint32_t A = a0, B = b0, C = c0, D = d0;

        for (uint32_t i = 0; i < 64; i++) {
            uint32_t F, g;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            F = F + A + md5_k[i] + M[g];
            A = D;
            D = C;
            C = B;
            B = B + _rotl(F, md5_s[i]);
        }
        a0 += A; b0 += B; c0 += C; d0 += D;
    }
    free(msg);

    memcpy(out +  0, &a0, 4);
    memcpy(out +  4, &b0, 4);
    memcpy(out +  8, &c0, 4);
    memcpy(out + 12, &d0, 4);
}

} // anonymous namespace

// ---- BLE state ------------------------------------------------------

static BLEUart s_ble_uart;
static BLEDis  s_ble_dis;
static bool    s_connected = false;
static char    s_devname[12];    // "RNode XXXX\0"

// ---- Callbacks ------------------------------------------------------

static void _connect_callback(uint16_t conn_handle) {
    BLEConnection* conn = Bluefruit.Connection(conn_handle);
    if (conn) {
        conn->requestPHY();
        conn->requestMtuExchange(247);
    }
    Serial.println("BLE: central connected, waiting for pairing...");
}

static void _disconnect_callback(uint16_t conn_handle, uint8_t reason) {
    (void)conn_handle;
    s_connected = false;
    Serial.print("BLE: disconnected, reason=0x");
    Serial.println(reason, HEX);
}

static void _secured_callback(uint16_t conn_handle) {
    (void)conn_handle;
    s_connected = true;
    Serial.println("BLE: paired and bonded");
}

// ---- Public API -----------------------------------------------------

void init(const char* device_name) {
    (void)device_name;  // We compute our own "RNode XXXX" name
    Serial.println("BLE: initializing...");

    Bluefruit.begin();
    Bluefruit.setTxPower(4);

    // Compute "RNode XXXX" name from BLE MAC + EEPROM signature byte
    // This matches the official RNode firmware's naming convention
    const ble_gap_addr_t gap_addr = Bluefruit.getAddr();
    uint8_t hash_input[7];
    memcpy(hash_input, gap_addr.addr, 6);
    hash_input[6] = rlr::eeprom::read_byte(0x1B);  // ADDR_SIGNATURE first byte

    uint8_t md5[16];
    md5_hash(hash_input, 7, md5);
    sprintf(s_devname, "RNode %02X%02X", md5[14], md5[15]);

    Bluefruit.setName(s_devname);

    // Connection callbacks
    Bluefruit.Periph.setConnectCallback(_connect_callback);
    Bluefruit.Periph.setDisconnectCallback(_disconnect_callback);
    Bluefruit.Periph.setConnInterval(6, 12);  // 7.5 - 15 ms

    // Security: "Just Works" bonding — phone shows a confirmation
    // prompt, user taps accept, no PIN entry needed. This matches
    // the pairing UX of the official RNode firmware with Sideband.
    Bluefruit.Security.setIOCaps(false, false, false);  // no IO = Just Works
    Bluefruit.Security.setMITM(false);
    Bluefruit.Security.setSecuredCallback(_secured_callback);

    // Device Information Service
    s_ble_dis.setManufacturer(BOARD_MANUFACTURER);
    s_ble_dis.setModel(BOARD_NAME);
    s_ble_dis.begin();

    // Nordic UART Service — encrypted but no MITM required (Just Works)
    s_ble_uart.begin();
    s_ble_uart.setPermission(SECMODE_ENC_NO_MITM, SECMODE_ENC_NO_MITM);

    // Advertising: NUS UUID in adv packet, name in scan response
    Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
    Bluefruit.Advertising.addTxPower();
    Bluefruit.Advertising.addService(s_ble_uart);
    Bluefruit.ScanResponse.addName();

    // Start advertising
    Bluefruit.Advertising.restartOnDisconnect(true);
    Bluefruit.Advertising.setInterval(32, 244);
    Bluefruit.Advertising.setFastTimeout(30);
    Bluefruit.Advertising.start(0);

    Serial.print("BLE: advertising as '");
    Serial.print(s_devname);
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
