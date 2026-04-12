/*
 * TRIAGE Robot — Dual-Mode Arduino Firmware
 *
 * MODE 1: LINE_FOLLOW  — Original line-follower logic (runs by default on boot)
 * MODE 2: COMMAND       — Pi 5 sends JSON commands for full motor control
 *
 * Switch modes via Serial:
 *   {"cmd":"MODE","mode":"COMMAND"}   → Pi takes control
 *   {"cmd":"MODE","mode":"LINE"}      → Revert to line following
 *
 * Command mode accepts:
 *   {"cmd":"MOVE","L":<-255..255>,"R":<-255..255>}  → Set motor speeds
 *   {"cmd":"STOP"}                                    → Emergency stop
 *   {"cmd":"PING"}                                    → Heartbeat check
 *   {"cmd":"SENSOR"}                                  → Request sensor read
 *
 * Telemetry (sent every 100ms in COMMAND mode):
 *   {"ir_l":<0|1>,"ir_r":<0|1>,"mode":"COMMAND"}
 *
 * Pin mapping preserved from original line.ino — DO NOT CHANGE.
 */

#include <ArduinoJson.h>

// --- PINOUT (UNCHANGED from line.ino) ---
#define enA 5    // Left Motor Speed (PWM)
#define in1 4    // Left Motor Logic
#define in2 7    // Left Motor Logic

#define enB 6    // Right Motor Speed (PWM)
#define in3 8    // Right Motor Logic
#define in4 11   // Right Motor Logic

#define L_S 12   // Left IR Sensor
#define R_S 13   // Right IR Sensor

#define TRIG 9   // Trigger pin of HC-SR04 (not connected — kept for pin reservation)
#define ECHO 10  // Echo pin of HC-SR04 (not connected — kept for pin reservation)

// --- SETTINGS (UNCHANGED from line.ino) ---
int spd = 200;
int turnSpd = 255;

// --- MODE CONTROL ---
enum RobotMode { LINE_FOLLOW, COMMAND };
RobotMode currentMode = LINE_FOLLOW;

// --- SERIAL BUFFER ---
char serialBuf[256];
int bufPos = 0;

// --- TELEMETRY TIMING ---
unsigned long lastTelemetry = 0;
const unsigned long TELEMETRY_INTERVAL = 100; // ms

// ========================================================
//  SETUP
// ========================================================
void setup() {
  Serial.begin(115200);

  // Sensor Pins
  pinMode(R_S, INPUT);
  pinMode(L_S, INPUT);

  // Motor Pins
  pinMode(enA, OUTPUT);
  pinMode(in1, OUTPUT);
  pinMode(in2, OUTPUT);
  pinMode(enB, OUTPUT);
  pinMode(in3, OUTPUT);
  pinMode(in4, OUTPUT);

  // Ultrasonic Pins (kept for pin reservation even if not connected)
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);

  // Start stopped
  stopMotors();

  // Boot message
  Serial.println("{\"status\":\"ready\",\"mode\":\"LINE\",\"fw\":\"triage-1.0\"}");
}

// ========================================================
//  MAIN LOOP
// ========================================================
void loop() {
  // Always check for serial commands (in both modes)
  processSerial();

  if (currentMode == LINE_FOLLOW) {
    lineFollowLoop();
  } else {
    commandModeLoop();
  }
}

// ========================================================
//  LINE-FOLLOWER LOGIC (UNCHANGED from line.ino)
// ========================================================
void lineFollowLoop() {
  // Wall detection (returns 999 if no ultrasonic connected)
  long distance = readDistance();
  if (distance > 0 && distance < 15) {
    turnAround();
    return;
  }

  // Read Sensors: LOW (0) = White, HIGH (1) = Black
  int left  = digitalRead(L_S);
  int right = digitalRead(R_S);

  if (left == 0 && right == 0) {
    forward();
  }
  else if (left == 0 && right == 1) {
    turnRight();
  }
  else if (left == 1 && right == 0) {
    turnLeft();
  }
  else {
    forward();
  }
}

// ========================================================
//  COMMAND MODE LOOP
// ========================================================
void commandModeLoop() {
  // Send telemetry at fixed interval
  unsigned long now = millis();
  if (now - lastTelemetry >= TELEMETRY_INTERVAL) {
    lastTelemetry = now;
    sendTelemetry();
  }
}

// ========================================================
//  SERIAL PROCESSING
// ========================================================
void processSerial() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n' || c == '\r') {
      if (bufPos > 0) {
        serialBuf[bufPos] = '\0';
        handleCommand(serialBuf);
        bufPos = 0;
      }
    } else {
      if (bufPos < (int)sizeof(serialBuf) - 1) {
        serialBuf[bufPos++] = c;
      }
    }
  }
}

void handleCommand(const char* json) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);

  if (err) {
    Serial.print("{\"error\":\"parse_fail\",\"detail\":\"");
    Serial.print(err.c_str());
    Serial.println("\"}");
    return;
  }

  const char* cmd = doc["cmd"];
  if (!cmd) {
    Serial.println("{\"error\":\"no_cmd\"}");
    return;
  }

  // --- MODE SWITCH ---
  if (strcmp(cmd, "MODE") == 0) {
    const char* mode = doc["mode"];
    if (mode && strcmp(mode, "COMMAND") == 0) {
      currentMode = COMMAND;
      stopMotors();
      Serial.println("{\"ack\":\"MODE\",\"mode\":\"COMMAND\"}");
    } else if (mode && strcmp(mode, "LINE") == 0) {
      currentMode = LINE_FOLLOW;
      Serial.println("{\"ack\":\"MODE\",\"mode\":\"LINE\"}");
    } else {
      Serial.println("{\"error\":\"invalid_mode\"}");
    }
    return;
  }

  // --- Commands below only work in COMMAND mode ---
  if (currentMode != COMMAND) {
    Serial.println("{\"error\":\"not_in_command_mode\",\"hint\":\"send {cmd:MODE,mode:COMMAND}\"}");
    return;
  }

  // --- MOVE ---
  if (strcmp(cmd, "MOVE") == 0) {
    int L = doc["L"] | 0;
    int R = doc["R"] | 0;
    setMotors(L, R);
    Serial.println("{\"ack\":\"MOVE\"}");
    return;
  }

  // --- STOP ---
  if (strcmp(cmd, "STOP") == 0) {
    stopMotors();
    Serial.println("{\"ack\":\"STOP\"}");
    return;
  }

  // --- PING ---
  if (strcmp(cmd, "PING") == 0) {
    Serial.println("{\"ack\":\"PONG\"}");
    return;
  }

  // --- SENSOR ---
  if (strcmp(cmd, "SENSOR") == 0) {
    sendTelemetry();
    return;
  }

  Serial.println("{\"error\":\"unknown_cmd\"}");
}

// ========================================================
//  MOTOR CONTROL (for COMMAND mode)
// ========================================================
// L, R: -255 to 255. Positive = forward, negative = reverse.
void setMotors(int L, int R) {
  // Left motor
  if (L >= 0) {
    digitalWrite(in1, HIGH);
    digitalWrite(in2, LOW);
  } else {
    digitalWrite(in1, LOW);
    digitalWrite(in2, HIGH);
  }
  analogWrite(enA, constrain(abs(L), 0, 255));

  // Right motor
  if (R >= 0) {
    digitalWrite(in3, HIGH);
    digitalWrite(in4, LOW);
  } else {
    digitalWrite(in3, LOW);
    digitalWrite(in4, HIGH);
  }
  analogWrite(enB, constrain(abs(R), 0, 255));
}

void stopMotors() {
  digitalWrite(in1, LOW);
  digitalWrite(in2, LOW);
  digitalWrite(in3, LOW);
  digitalWrite(in4, LOW);
  analogWrite(enA, 0);
  analogWrite(enB, 0);
}

// ========================================================
//  TELEMETRY
// ========================================================
void sendTelemetry() {
  int left  = digitalRead(L_S);
  int right = digitalRead(R_S);

  Serial.print("{\"ir_l\":");
  Serial.print(left);
  Serial.print(",\"ir_r\":");
  Serial.print(right);
  Serial.print(",\"mode\":\"");
  Serial.print(currentMode == LINE_FOLLOW ? "LINE" : "COMMAND");
  Serial.println("\"}");
}

// ========================================================
//  ORIGINAL MOTOR FUNCTIONS (UNCHANGED — used by line follower)
// ========================================================
void forward() {
  digitalWrite(in1, HIGH);
  digitalWrite(in2, LOW);
  analogWrite(enA, spd);

  digitalWrite(in3, HIGH);
  digitalWrite(in4, LOW);
  analogWrite(enB, spd);
}

void turnRight() {
  digitalWrite(in1, HIGH);
  digitalWrite(in2, LOW);
  analogWrite(enA, turnSpd);

  digitalWrite(in3, LOW);
  digitalWrite(in4, HIGH);
  analogWrite(enB, turnSpd);
}

void turnLeft() {
  digitalWrite(in1, LOW);
  digitalWrite(in2, HIGH);
  analogWrite(enA, turnSpd);

  digitalWrite(in3, HIGH);
  digitalWrite(in4, LOW);
  analogWrite(enB, turnSpd);
}

void Stop() {
  stopMotors();
}

// ========================================================
//  ULTRASONIC (UNCHANGED — returns 999 if no sensor)
// ========================================================
long readDistance() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  long duration = pulseIn(ECHO, HIGH, 30000);

  if (duration == 0) {
    return 999;
  }

  float dist = duration * 0.034 / 2;
  return (long)dist;
}

// ========================================================
//  180° TURN (UNCHANGED — used by line follower)
// ========================================================
void turnAround() {
  stopMotors();
  delay(100);

  digitalWrite(in1, HIGH);
  digitalWrite(in2, LOW);
  digitalWrite(in3, LOW);
  digitalWrite(in4, HIGH);
  analogWrite(enA, turnSpd);
  analogWrite(enB, turnSpd);

  delay(500);

  stopMotors();
  delay(100);
}
