// AX-1 bridge configuration: pick the body, set the passkey, check the pins against YOUR board. CC0.
// Pins are for a generic ESP32-WROOM-32 DevKit (38-pin). Boards with an on-board servo bus / TB6612
// (e.g. Waveshare "General Driver for Robots") use other pins: read their schematic and change them here.
#pragma once
#include "ax_proto.h"

// ---------------------------------------------------------------- body: BODY_ROVER, BODY_DESK or BODY_WALKER
#define AX_BODY ax::BODY_ROVER

// ---------------------------------------------------------------- security
// 6-digit static passkey for LE Secure Connections. Pick your own number from 100000 to 999999 (no leading
// zero: C would read it as octal), print it on a sticker on the robot, and never publish it. The sketch does not
// compile until you set it, so no two robots ship with the same default. Pick it at random: repeated digits,
// runs (123456, 987654), repeated pairs or triples (121212, 123123) and numbers like 100000 are refused; dates
// and other guessable numbers are just as weak. After 5 failed links the robot refuses every connection for 60 s.
#define AX_PASSKEY 0
#define AX_NAME "AX-1"
#define AX_PAIR_HOLD_MS 2000    // hold BOOT 2 s: opens the 60 s pairing window
#define AX_CLEAR_BONDS_MS 10000 // hold BOOT 10 s: forgets every paired phone
// Press BOOT 3 times within 2 s (robot stopped, torque off) to enter or leave config mode (joint limits).
// Note: holding BOOT while powering on starts the ESP32 bootloader, so it cannot be used for config mode.

// ---------------------------------------------------------------- pins
// Never use the ESP32 strapping pins 0, 2, 5, 12, 15 for outputs, never 6-11 (flash), and avoid 1, 3, 14
// (UART0 / a PWM burst at boot).
#define PIN_BOOT_BUTTON 0  // the on-board BOOT button (input only after boot: safe)
#define PIN_STATUS_LED -1  // optional LED, -1 = none

// Rover: TB6612FNG dual H-bridge. STBY needs an external 10 k pull-down so the driver is off at power-up.
#define PIN_TB_STBY 32
#define PIN_TB_PWMA 25
#define PIN_TB_AIN1 26
#define PIN_TB_AIN2 27
#define PIN_TB_PWMB 4
#define PIN_TB_BIN1 13
#define PIN_TB_BIN2 33
#define MOTOR_PWM_HZ 20000
#define MOTOR_LEFT_INVERT 0
#define MOTOR_RIGHT_INVERT 1  // the two motors face opposite ways

// Rover: hobby servos (SG90 / MG90S class) for the phone head
#define PIN_SERVO_PAN 22
#define PIN_SERVO_TILT 23
#define SERVO_US_CENTER 1500
#define SERVO_US_PER_DEG 10  // ~1000..2000 us over +-50 deg; check your servo, never exceed 500..2500
#define SERVO_PAN_DIR 1
#define SERVO_TILT_DIR -1

// Desk / Walker: half-duplex TTL bus to the STS3215 servos at 1 Mbps (e.g. through a Waveshare Bus Servo Adapter).
#define PIN_BUS_RX 18
#define PIN_BUS_TX 19
#define BUS_BAUD 1000000
#define BUS_ECHO 1          // 1 if the adapter echoes what we send (most one-wire adapters do)
#define BUS_TIMEOUT_US 3000 // per reply

// Per-joint calibration for bus servos: raw position at 0 deg and direction (+1/-1), in table order (ID 1..n).
// 2048 is the factory centre. Measure yours and edit; joint limits (deg) live in ax_proto.h and NVS.
#define BUS_CENTERS {2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048}
#define BUS_DIRS {1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1}

// ---------------------------------------------------------------- power
// Battery through a divider into an ADC1 pin (ADC2 does not work while the radio is on). -1 disables the check
// (then the low-voltage cutoff relies on the servos' own voltage error only: not recommended).
#define PIN_BATT_ADC 34
#define BATT_DIVIDER_X1000 4030  // (R1 + R2) / R2 x 1000, e.g. 30 k + 10 k = 4.0; calibrate with a multimeter
#define BATT_HYST_MV 200         // ARM needs the battery this far above the cutoff (cutoff per body in ax_proto.h)
