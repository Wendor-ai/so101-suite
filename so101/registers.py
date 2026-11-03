"""The STS3215 register map (Feetech memory table), in plain words. Used to explain bus traffic: addr -> {name, size, desc}."""
from typing import Optional

REGISTERS = {
    0: {"name": "Firmware_Major_Version", "size": 1, "desc": "Firmware version (major)."},
    1: {"name": "Firmware_Minor_Version", "size": 1, "desc": "Firmware version (minor)."},
    3: {"name": "Model_Number", "size": 2, "desc": "Which motor model this is (777 = STS3215)."},
    5: {"name": "ID", "size": 1, "desc": "The motor's address on the bus. The SO-101 uses 1 to 6, from the base to the gripper."},
    6: {"name": "Baud_Rate", "size": 1, "desc": "Communication speed code (0 = 1 Mbit/s, the factory setting)."},
    7: {"name": "Return_Delay_Time", "size": 1, "desc": "How long the motor waits before answering."},
    8: {"name": "Response_Status_Level", "size": 1, "desc": "Whether the motor answers write commands."},
    9: {"name": "Min_Position_Limit", "size": 2, "desc": "Lowest position the motor is allowed to go to (0 to 4095). Set by calibration."},
    11: {"name": "Max_Position_Limit", "size": 2, "desc": "Highest position the motor is allowed to go to (0 to 4095). Set by calibration."},
    13: {"name": "Max_Temperature_Limit", "size": 1, "desc": "Temperature at which the motor protects itself."},
    14: {"name": "Max_Voltage_Limit", "size": 1, "desc": "Highest allowed supply voltage."},
    15: {"name": "Min_Voltage_Limit", "size": 1, "desc": "Lowest allowed supply voltage."},
    16: {"name": "Max_Torque_Limit", "size": 2, "desc": "Highest torque the motor may use (permille of its maximum)."},
    21: {"name": "P_Coefficient", "size": 1, "desc": "Position control: how hard it pulls towards the goal."},
    22: {"name": "D_Coefficient", "size": 1, "desc": "Position control: damping."},
    23: {"name": "I_Coefficient", "size": 1, "desc": "Position control: how it removes a steady error."},
    24: {"name": "Minimum_Startup_Force", "size": 2, "desc": "Smallest force that makes the motor start moving."},
    28: {"name": "Protection_Current", "size": 2, "desc": "Current at which overload protection starts."},
    31: {"name": "Homing_Offset", "size": 2, "desc": "Shifts the zero of the position scale. Calibration sets it so the middle pose reads 2047."},
    33: {"name": "Operating_Mode", "size": 1, "desc": "0 = position control (the normal mode)."},
    34: {"name": "Protective_Torque", "size": 1, "desc": "Torque used while protecting after an overload."},
    35: {"name": "Protection_Time", "size": 1, "desc": "How long an overload lasts before protection trips."},
    36: {"name": "Overload_Torque", "size": 1, "desc": "Torque level that counts as an overload."},
    40: {"name": "Torque_Enable", "size": 1, "desc": "1 = the motor holds and moves; 0 = limp, you can move it by hand."},
    41: {"name": "Acceleration", "size": 1, "desc": "How quickly it speeds up and slows down (lower = gentler)."},
    42: {"name": "Goal_Position", "size": 2, "desc": "Where the motor should go (0 to 4095, 4095 = one full turn)."},
    44: {"name": "Goal_Time", "size": 2, "desc": "Time to reach the goal (unused in position mode)."},
    46: {"name": "Goal_Speed", "size": 2, "desc": "How fast it may move towards the goal (steps per second)."},
    48: {"name": "Torque_Limit", "size": 2, "desc": "Strength limit for this motor (0 to 1000, permille of maximum)."},
    55: {"name": "Lock", "size": 1, "desc": "1 = the motor's saved settings (EEPROM) are write-protected. Set it to 0 before changing the ID or limits."},
    56: {"name": "Present_Position", "size": 2, "desc": "Where the motor is right now (0 to 4095)."},
    58: {"name": "Present_Speed", "size": 2, "desc": "How fast it is moving right now."},
    60: {"name": "Present_Load", "size": 2, "desc": "How hard it is pushing right now (0 to 1000 = 0 to 100 % of its maximum torque; bit 10 is the direction)."},
    62: {"name": "Present_Voltage", "size": 1, "desc": "Supply voltage in tenths of a volt (74 = 7.4 V)."},
    63: {"name": "Present_Temperature", "size": 1, "desc": "Motor temperature in degrees Celsius."},
    65: {"name": "Status", "size": 1, "desc": "Fault flags: voltage, sensor, temperature, current, angle, overload. 0 = healthy."},
    66: {"name": "Moving", "size": 1, "desc": "1 while the motor is moving."},
    69: {"name": "Present_Current", "size": 2, "desc": "Current the motor draws right now."},
}


def describe(addr: int) -> Optional[dict]:
    r = REGISTERS.get(addr)
    return dict(r, addr=addr) if r else None


def name_of(addr: int) -> str:
    r = REGISTERS.get(addr)
    return r["name"] if r else f"reg{addr}"
