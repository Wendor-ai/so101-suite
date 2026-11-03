"""Gentle wiggle loop for wrist roll (5) and gripper (6). Ctrl-C / kill to stop; torque is released on exit."""
import sys, time, signal, scservo_sdk as s
PORT = sys.argv[1]; IDS = (5, 6); AMP = {5: 450, 6: 300}
ph = s.PortHandler(PORT); ph.openPort(); ph.setBaudRate(1000000); pk = s.PacketHandler(0)
w1 = lambda i, a, v: pk.write1ByteTxRx(ph, i, a, v)
w2 = lambda i, a, v: pk.write2ByteTxRx(ph, i, a, v)
r2 = lambda i: pk.read2ByteTxRx(ph, i, 56)[0]
def release(*_):
    for i in IDS: w1(i, 40, 0)
    ph.closePort(); sys.exit(0)
signal.signal(signal.SIGTERM, release); signal.signal(signal.SIGINT, release)
for i in IDS:
    w1(i, 40, 0); w1(i, 55, 0)            # torque off, unlock EEPROM
    w1(i, 33, 0)                          # position mode
    w2(i, 9, 0); w2(i, 11, 4095)          # open limits (calibration will reset these)
    w1(i, 55, 1)
start = {i: r2(i) for i in IDS}
for i in IDS:
    w1(i, 41, 20); w2(i, 46, 500); w2(i, 42, start[i]); w1(i, 40, 1)
time.sleep(0.3)
while True:
    for d in (1, -1):
        for i in IDS: w2(i, 42, max(0, min(4095, start[i] + d * AMP[i])))
        time.sleep(0.8)
