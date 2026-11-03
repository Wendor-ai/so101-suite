// SO-101 Inspector content: what the numbers on the motor cable mean, in plain words.
// The six joints are Feetech STS3215 servos. Each motor has a small memory table; a "register" is one entry in it,
// and its address is the register number (56 = where the joint is). Pure data and pure functions: no DOM, no network.
// pages/inspector.js turns "read2 id=3 addr=56 value=2048" into a sentence a beginner can follow with this file.

export const MOTOR_JOINT = { 1: 'shoulder pan', 2: 'shoulder lift', 3: 'elbow flex', 4: 'wrist flex', 5: 'wrist roll', 6: 'gripper' };
export const jointOf = (id) => MOTOR_JOINT[id] || null;
/** "motor 3 (elbow flex)" */
export const motorLabel = (id) => (id == null ? 'a motor' : `motor ${id}${jointOf(id) ? ` (${jointOf(id)})` : ''}`);

/* ---------- number helpers ---------- */
export const TICKS_PER_TURN = 4096;
export const DEG_PER_TICK = 360 / TICKS_PER_TURN; // 0.0879
export const MIDDLE_TICKS = 2048;
export const ticksToDeg = (v) => (v - MIDDLE_TICKS) * DEG_PER_TICK;
const sgn = (n, d = 1) => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(d);
export const fmtDeg = (v) => `${sgn(ticksToDeg(v))} degrees`;
/** Sign-magnitude, as the motor stores it: the bit says "negative", the rest is the size. */
export const signMag = (v, bit) => ((v & (1 << bit)) ? -(v & ((1 << bit) - 1)) : v);
/** Present_Load arrives as sign bit 10 + magnitude in 0.1 % units; some backends already give a signed number. */
export const loadTenths = (v) => (v < 0 ? v : signMag(v & 2047, 10));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export { esc };

/* ---------- fault bits (register 65 Status, also the error byte of a reply) ---------- */
export const FAULTS = [
  { bit: 1, key: 'voltage', label: 'Voltage', plain: 'The power the motor receives is too low or too high. Check the power supply is the right one and plugged in firmly.' },
  { bit: 2, key: 'sensor', label: 'Sensor', plain: 'The motor’s angle sensor reported a problem. Power the arm off and on again; if it stays, that motor may need replacing.' },
  { bit: 4, key: 'temperature', label: 'Temperature', plain: 'The motor is too hot. Let the arm rest with the power off for a few minutes.' },
  { bit: 8, key: 'current', label: 'Current', plain: 'The motor drew too much electric current, usually because it pushed hard against something. Free the arm.' },
  { bit: 16, key: 'angle', label: 'Angle', plain: 'The joint went outside the range it is allowed to move in.' },
  { bit: 32, key: 'overload', label: 'Overload', plain: 'The motor pushed too hard for too long (jammed, or holding something heavy). It protects itself and goes limp until torque is switched off and on.' },
];
export const faultsOf = (v) => FAULTS.filter((f) => (v & f.bit) !== 0);
export const faultText = (v) => { const l = faultsOf(v); return l.length ? l.map((f) => f.key).join(', ') : 'none'; };

const BAUD = { 0: '1,000,000', 1: '500,000', 2: '250,000', 3: '128,000', 4: '115,200', 5: '76,800', 6: '57,600', 7: '38,400' };

/* ---------- how to show and explain a value, by kind ---------- */
// raw(v): the number as the motor says it. text(v): short form for a table row. plain(v): a sentence for Explain. tell(v): "told motor 3 <this>".
const F = {
  int: { raw: (v) => String(v), plain: (v) => `The value is ${v}.` },
  id: {
    raw: (v) => `ID ${v}`,
    text: (v) => `${v}${jointOf(v) ? ` (${jointOf(v)})` : ''}`,
    plain: (v) => (jointOf(v) ? `Motor ID ${v} is the ${jointOf(v)} on an SO-101.` : `${v} is not one of the SO-101 IDs (1 to 6).`),
    tell: (v) => `to answer to ID ${v} from now on`,
  },
  baud: {
    raw: (v) => String(v),
    text: (v) => (BAUD[v] ? `${BAUD[v]} bits/s` : String(v)),
    plain: (v) => (v === 0 ? 'Code 0 means 1,000,000 bits per second, the speed the SO-101 uses. Everything on the cable must agree on it.' : `Code ${v} is a speed code. The SO-101 expects code 0 (1,000,000 bits per second); other codes make the motor look missing.`),
  },
  pos: {
    raw: (v) => `${v} ticks`,
    text: (v) => (v >= 0 && v <= 4095 ? `${v} (${fmtDeg(v)})` : `${v} (outside the 0 to 4095 range)`),
    plain: (v) => (v >= 0 && v <= 4095
      ? `The middle of the range is 0 degrees, so the joint is at ${fmtDeg(v)}. One full turn is 4096 ticks, so one tick is about 0.088 degrees.`
      : `A position is a whole number from 0 to 4095 (one full turn). ${v} is outside that range, which usually means a garbled reading.`),
    tell: (v) => `to go to ${v} ticks (${fmtDeg(v)})`,
  },
  limit: {
    raw: (v) => `${v} ticks`,
    text: (v) => `${v} (${fmtDeg(v)})`,
    plain: (v) => `The motor will refuse to turn past ${v} ticks (${fmtDeg(v)}) on this side. Calibration sets these to the ends of your joint’s range.`,
    tell: (v) => `to stop at ${v} ticks (${fmtDeg(v)})`,
  },
  offset: {
    raw: (v) => `${signMag(v, 11)} ticks`,
    text: (v) => `${signMag(v, 11)} ticks (${sgn(signMag(v, 11) * DEG_PER_TICK)} degrees)`,
    plain: (v) => `A shift the motor adds to what its sensor sees, so that the middle of your joint’s range reads as 2048 (0 degrees). Calibration sets it. Here the shift is ${signMag(v, 11)} ticks.`,
    tell: (v) => `to shift its zero by ${signMag(v, 11)} ticks`,
  },
  speed: {
    raw: (v) => `${signMag(v, 15)} ticks/s`,
    text: (v) => `${Math.abs(signMag(v, 15))} ticks/s`,
    plain: (v) => `${Math.abs(signMag(v, 15))} ticks per second (a tick is about 0.088 degrees). 0 means standing still.`,
    tell: (v) => `to move at ${Math.abs(signMag(v, 15))} ticks per second`,
  },
  accel: { raw: (v) => String(v), plain: (v) => `How gently the motor speeds up and slows down. Higher is snappier; 0 is the gentlest the motor offers.`, tell: (v) => `to accelerate at level ${v}` },
  pct10: {
    raw: (v) => String(v),
    text: (v) => `${(v / 10).toFixed(0)}%`,
    plain: (v) => `${(v / 10).toFixed(0)}% of the strongest push the motor can make (1000 means 100%). A lower limit makes the arm gentler.`,
    tell: (v) => `to push with at most ${(v / 10).toFixed(0)}% of its strength`,
  },
  load: {
    raw: (v) => String(v),
    text: (v) => { const n = loadTenths(v); return `${sgn(n / 10)}% load`; },
    plain: (v) => { const n = loadTenths(v); return `The motor is pushing with ${Math.abs(n / 10).toFixed(1)}% of its maximum strength (the + or - is the direction it pushes). Near 0 means resting; a long stretch above about 50% means it is working hard or is blocked.`; },
  },
  volt: {
    raw: (v) => `${v} (0.1 V units)`,
    text: (v) => `${(v / 10).toFixed(1)} V`,
    plain: (v) => `${(v / 10).toFixed(1)} volts: the power the motor receives. It should stay steady. A big drop when the arm moves points to a weak power supply or a loose connector.`,
    tell: (v) => `to allow ${(v / 10).toFixed(1)} V`,
  },
  temp: {
    raw: (v) => `${v} °C`,
    text: (v) => `${v} °C`,
    plain: (v) => `${v} degrees Celsius inside the motor. Warm is normal while it works. If it keeps climbing past about 60 °C, let the arm rest.`,
    tell: (v) => `to allow up to ${v} °C`,
  },
  current: {
    raw: (v) => String(v),
    text: (v) => `${Math.round(signMag(v, 15) * 6.5)} mA`,
    plain: (v) => `About ${Math.round(Math.abs(signMag(v, 15)) * 6.5)} milliamps flowing through the motor. More current means more effort.`,
  },
  status: {
    raw: (v) => `${v}`,
    text: (v) => (v & 63 ? `fault: ${faultText(v & 63)}` : 'no faults'),
    plain: (v) => (v & 63 ? `At least one protection tripped (${faultText(v & 63)}). The motor protects itself by going soft until it is reset.` : 'All the motor’s protections are quiet. 0 means everything is fine.'),
  },
  torque: {
    raw: (v) => String(v),
    text: (v) => (v === 0 ? 'limp (torque off)' : v === 1 ? 'holding (torque on)' : v === 128 ? 'set middle (128)' : String(v)),
    plain: (v) => (v === 0 ? 'Torque off means the motor is limp: the joint moves freely by hand and the motor does not push.'
      : v === 1 ? 'Torque on means the motor is holding its goal position. It pushes back if you move the joint.'
        : v === 128 ? 'The special value 128 tells the motor “call the position you are at now the middle (2048)”.' : `Torque Enable is 0 (limp) or 1 (holding); ${v} is unusual.`),
    tell: (v) => (v === 0 ? 'to go limp (torque off)' : v === 1 ? 'to hold (torque on)' : v === 128 ? 'to treat its current position as the middle' : `to set torque to ${v}`),
  },
  lock: {
    raw: (v) => String(v),
    text: (v) => (v ? 'locked' : 'unlocked'),
    plain: (v) => (v ? 'Locked: the settings stored in the motor are protected from changes.' : 'Unlocked: the settings stored in the motor can be changed now. The app unlocks, saves a setting, then locks again.'),
    tell: (v) => (v ? 'to lock its saved settings' : 'to unlock its saved settings'),
  },
  moving: { raw: (v) => String(v), text: (v) => (v ? 'moving' : 'still'), plain: (v) => (v ? 'The motor says it is moving right now.' : 'The motor says it is standing still.') },
  mode: {
    raw: (v) => String(v),
    text: (v) => ({ 0: 'position', 1: 'speed', 2: 'PWM', 3: 'step' }[v] || String(v)),
    plain: (v) => ({ 0: 'Position mode: give the motor an angle and it goes there and holds. This is what an arm joint uses.', 1: 'Speed mode: the motor spins at a set speed (a wheel).', 2: 'PWM mode: raw power with no feedback.', 3: 'Step mode: the motor moves a set number of steps.' }[v] || `Mode ${v} is not one the SO-101 uses.`),
    tell: (v) => `to work in ${({ 0: 'position', 1: 'speed', 2: 'PWM', 3: 'step' }[v] || 'mode ' + v)} mode`,
  },
};

/* ---------- the register map ---------- */
// [addr, name, bytes, short noun, kind, what it is, how to read it, "asked motor N …" phrase]
const T = [
  [3, 'Model_Number', 2, 'model number', 'int', 'Which kind of motor this is (the STS3215 reports 777).', 'A fixed number set at the factory.', 'what model it is'],
  [5, 'ID', 1, 'motor ID', 'id', 'The motor’s name on the shared cable. Only the motor with this ID answers.', 'A whole number from 1 to 253. On an SO-101: 1 shoulder pan, 2 shoulder lift, 3 elbow flex, 4 wrist flex, 5 wrist roll, 6 gripper.', 'what its ID is'],
  [6, 'Baud_Rate', 1, 'baud rate', 'baud', 'How fast the motor and the board talk. Both must use the same speed.', 'A code: 0 = 1,000,000 bits/s (what the SO-101 uses), 1 = 500,000, 2 = 250,000, 3 = 128,000, 4 = 115,200 …', 'what speed it talks at'],
  [7, 'Return_Delay_Time', 1, 'reply delay', 'int', 'How long the motor waits before answering.', 'In units of 2 microseconds.', 'how long it waits before answering'],
  [8, 'Response_Status_Level', 1, 'reply level', 'int', 'Whether the motor answers write commands.', '0 = answer only to reads and pings, 1 = answer to everything.', 'whether it answers to writes'],
  [9, 'Min_Position_Limit', 2, 'minimum position limit', 'limit', 'The lowest position the motor is allowed to turn to.', '0 to 4095 ticks; 2048 is the middle.', 'its lowest allowed position'],
  [11, 'Max_Position_Limit', 2, 'maximum position limit', 'limit', 'The highest position the motor is allowed to turn to.', '0 to 4095 ticks; 2048 is the middle.', 'its highest allowed position'],
  [13, 'Max_Temperature_Limit', 1, 'temperature limit', 'temp', 'The temperature above which the motor protects itself.', 'Degrees Celsius.', 'its temperature limit'],
  [14, 'Max_Voltage_Limit', 1, 'maximum voltage', 'volt', 'The highest supply voltage the motor accepts.', 'In 0.1 V units: 80 = 8.0 V.', 'its highest allowed voltage'],
  [15, 'Min_Voltage_Limit', 1, 'minimum voltage', 'volt', 'The lowest supply voltage the motor accepts.', 'In 0.1 V units: 40 = 4.0 V.', 'its lowest allowed voltage'],
  [16, 'Max_Torque_Limit', 2, 'maximum torque', 'pct10', 'The strongest push the motor may ever make.', '0 to 1000 in 0.1% units (1000 = 100%).', 'its maximum strength'],
  [21, 'P_Coefficient', 1, 'P gain', 'int', 'How strongly the motor corrects when it is away from its goal (the “P” of PID).', 'A small whole number; higher is stiffer but can shake.', 'its stiffness (P gain)'],
  [22, 'D_Coefficient', 1, 'D gain', 'int', 'How much the motor damps its movement (the “D” of PID).', 'A small whole number; higher is smoother.', 'its damping (D gain)'],
  [23, 'I_Coefficient', 1, 'I gain', 'int', 'How much the motor fixes a small steady error (the “I” of PID).', 'A small whole number; 0 turns it off.', 'its I gain'],
  [28, 'Protection_Current', 2, 'protection current', 'current', 'The current above which the motor protects itself.', 'About 6.5 mA per unit.', 'its current limit'],
  [31, 'Homing_Offset', 2, 'homing offset', 'offset', 'A shift added to the angle sensor so the middle of your joint’s range reads as 2048 (0 degrees). Calibration sets it.', 'Sign bit 11: the top bit means “negative”, the rest is the size in ticks.', 'how far its zero is shifted'],
  [33, 'Operating_Mode', 1, 'operating mode', 'mode', 'How the motor behaves: hold an angle, spin at a speed, and so on.', '0 = position (arm joints), 1 = speed, 2 = PWM, 3 = step.', 'which mode it works in'],
  [40, 'Torque_Enable', 1, 'torque', 'torque', 'The motor’s on/off switch for holding.', '1 = holding (the motor pushes to stay at its goal), 0 = limp (moves freely by hand).', 'whether it is holding or limp'],
  [41, 'Acceleration', 1, 'acceleration', 'accel', 'How gently the motor speeds up and slows down.', '0 to 254; higher is snappier.', 'how it accelerates'],
  [42, 'Goal_Position', 2, 'goal position', 'pos', 'Where the motor has been told to go.', '0 to 4095 ticks, 0.0879 degrees per tick; 2048 is the middle (0 degrees).', 'where it was told to go'],
  [44, 'Goal_Time', 2, 'goal time', 'int', 'How long a move should take.', 'In milliseconds (0 = as fast as allowed).', 'how long its move should take'],
  [46, 'Goal_Velocity', 2, 'goal speed', 'speed', 'How fast the motor may turn toward its goal.', 'Ticks per second (a tick is 0.0879 degrees). Sign bit 15 means “backwards”.', 'how fast it may move'],
  [48, 'Torque_Limit', 2, 'torque limit', 'pct10', 'How strongly the motor may push right now.', '0 to 1000 in 0.1% units (1000 = 100%).', 'how strongly it may push'],
  [55, 'Lock', 1, 'saved-settings lock', 'lock', 'Protects the settings stored in the motor (its EEPROM) from being changed.', '1 = locked, 0 = unlocked. The app unlocks, saves a setting, then locks again.', 'whether its saved settings are locked'],
  [56, 'Present_Position', 2, 'position', 'pos', 'Where the joint is right now.', '0 to 4095 ticks, 0.0879 degrees per tick; 2048 is the middle (0 degrees).', 'where it is'],
  [58, 'Present_Velocity', 2, 'speed', 'speed', 'How fast the joint is turning right now.', 'Ticks per second; sign bit 15 means “backwards”.', 'how fast it is turning'],
  [60, 'Present_Load', 2, 'load', 'load', 'How hard the motor is pushing right now (more load means more effort).', 'Sign bit 10 = direction, the rest is the strength in 0.1% units (500 = 50.0%).', 'how hard it is pushing (its load)'],
  [62, 'Present_Voltage', 1, 'voltage', 'volt', 'The supply voltage the motor sees.', 'In 0.1 V units: 74 = 7.4 V.', 'the voltage it sees'],
  [63, 'Present_Temperature', 1, 'temperature', 'temp', 'How hot the motor is inside.', 'Degrees Celsius.', 'how hot it is'],
  [65, 'Status', 1, 'fault flags', 'status', 'Whether any of the motor’s protections have tripped.', 'Each bit is one fault: 1 voltage, 2 sensor, 4 temperature, 8 current, 16 angle, 32 overload. 0 = all fine.', 'whether anything is wrong (its fault flags)'],
  [66, 'Moving', 1, 'moving flag', 'moving', 'Whether the motor is moving.', '1 = moving, 0 = still.', 'whether it is moving'],
  [69, 'Present_Current', 2, 'current', 'current', 'How much electric current the motor draws right now.', 'About 6.5 mA per unit.', 'how much current it draws'],
];

export const REGISTERS = Object.fromEntries(T.map(([addr, name, size, noun, kind, what, how, ask]) => [addr, { addr, name, size, noun, kind, what, how, ask }]));
const BY_NAME = Object.fromEntries(Object.values(REGISTERS).map((r) => [r.name.toLowerCase(), r]));
export const regInfo = (addr) => REGISTERS[addr] || null;
/** Find a register by number, or by name ("present_position", "Present Position"). */
export function regFind(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'number' || /^\d+$/.test(String(x))) return REGISTERS[Number(x)] || null;
  return BY_NAME[String(x).toLowerCase().replace(/[\s-]+/g, '_')] || null;
}
/** The register of a bus entry: by address first, else by its `reg` name. */
export const regOf = (item) => regFind(item?.addr) || regFind(item?.reg);
/** Registers that the app reads over and over, 10 times a second, so the screen stays live. */
export const POLL_ADDRS = new Set([56, 65, 60, 63, 62]);

/** {raw, text, plain, tell} for a register value; unknown registers still get a sane answer. */
export function describeValue(addr, value) {
  const r = regFind(addr);
  const v = typeof value === 'number' ? value : Number(value);
  if (!r || value == null || Number.isNaN(v)) return { reg: r, raw: String(value ?? ''), text: String(value ?? ''), plain: '', tell: `to set it to ${value}` };
  const f = F[r.kind] || F.int;
  const raw = f.raw(v);
  return { reg: r, raw, text: f.text ? f.text(v) : raw, plain: f.plain ? f.plain(v) : '', tell: f.tell ? f.tell(v) : `to set its ${r.noun} to ${f.text ? f.text(v) : raw}` };
}

/* ---------- bus operations and sizes ---------- */
export const OPS = {
  ping: { label: 'Ping', long: 'Ping: “are you there?” A ping never moves a motor.', bytes: 0 },
  read1: { label: 'Read 1 byte', long: 'Read: ask the motor for the value of one of its registers (1 byte).', bytes: 1 },
  read2: { label: 'Read 2 bytes', long: 'Read: ask the motor for the value of one of its registers (2 bytes).', bytes: 2 },
  write1: { label: 'Write 1 byte', long: 'Write: tell the motor to change one of its registers (1 byte).', bytes: 1 },
  write2: { label: 'Write 2 bytes', long: 'Write: tell the motor to change one of its registers (2 bytes).', bytes: 2 },
};
export const isRead = (op) => op === 'read1' || op === 'read2';
export const isWrite = (op) => op === 'write1' || op === 'write2';
/** Bytes on the wire for one exchange (the message out plus the motor's reply). Protocol arithmetic, not a guess. */
export function busBytes(op) {
  switch (op) {
    case 'ping': return 6 + 6;
    case 'read1': return 8 + 7;
    case 'read2': return 8 + 8;
    case 'write1': return 8 + 6;
    case 'write2': return 9 + 6;
    default: return null;
  }
}

/** What an error text usually means, and the next thing to try. */
export function explainError(err) {
  const e = String(err || '');
  if (/busy|stuck|lock/i.test(e)) return { title: 'The bus was busy', text: 'Another part of the app was using the motor cable at that moment, so this message waited and gave up. A few of these are harmless. Many in a row mean something is hogging the bus.' };
  if (/checksum|crc|corrupt|garbl|bad (reply|packet)/i.test(e)) return { title: 'The answer arrived damaged', text: 'The motor replied, but the bytes did not add up. Usual causes: a loose or damaged cable, electrical noise, or a different baud rate than the app expects.' };
  if (/port|serial|usb|disconnect|device|open/i.test(e)) return { title: 'The USB port could not be used', text: 'Was the arm’s USB cable unplugged, or is another program using the port? Plug it back in and close other programs that use the arm.' };
  if (/timeout|time out|no answer|no response|not respond|did not answer|rx|none/i.test(e)) return { title: 'The motor did not answer in time', text: 'Usual causes: a cable that is not fully clicked in, the power supply switched off, or a motor with the wrong ID.' };
  return { title: 'The motor or the cable reported a problem', text: 'Open Test motors to check each motor one by one.' };
}

/* ---------- Feetech packets (what the raw bytes mean) ---------- */
export const INSTRUCTIONS = {
  0x01: ['PING', 'are you there?'],
  0x02: ['READ', 'tell me the value of these registers'],
  0x03: ['WRITE', 'set these registers'],
  0x04: ['REG WRITE', 'store this write, but wait for ACTION'],
  0x05: ['ACTION', 'do the stored writes now'],
  0x06: ['RESET', 'restore factory settings'],
  0x82: ['SYNC READ', 'read the same registers from several motors at once'],
  0x83: ['SYNC WRITE', 'write to several motors in one message'],
};
export const hex2 = (b) => (b & 255).toString(16).padStart(2, '0');
/** "ff ff 03 …" / "FFFF03" / "0xff 0xff" -> [255, 255, 3, …] */
export function hexBytes(hex) {
  const s = String(hex ?? '').replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}
export const spaced = (bytes) => bytes.map(hex2).join(' ');
/** Split a byte string into Feetech packets: FF FF, ID, LENGTH, INSTRUCTION-or-ERROR, parameters, CHECKSUM.
 *  LENGTH counts everything after itself (code + parameters + checksum). CHECKSUM = ~(ID + LENGTH + code + parameters) & 0xFF. */
export function parsePackets(bytes) {
  const packets = [], stray = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xff && i + 3 < bytes.length) {
      const id = bytes[i + 2], len = bytes[i + 3], end = Math.min(bytes.length, i + 4 + len), truncated = i + 4 + len > bytes.length;
      const code = bytes[i + 4];
      const hasChk = !truncated && len >= 2;
      const params = bytes.slice(i + 5, hasChk ? end - 1 : end);
      const chk = hasChk ? bytes[end - 1] : null;
      const sum = (id + len + (code ?? 0) + params.reduce((a, b) => a + b, 0));
      const expected = (~sum) & 0xff;
      packets.push({ at: i, bytes: bytes.slice(i, end), id, len, code, params, chk, expected, checksumOk: hasChk ? chk === expected : null, truncated });
      i = end;
    } else { stray.push(bytes[i]); i += 1; }
  }
  return { packets, stray };
}
const word = (lo, hi) => lo + hi * 256;
/** Rows [{bytes, field, meaning}] explaining one packet. dir 'tx' = the app asking, 'rx' = the motor answering. hint {addr} names the register of a reply. */
export function describePacket(p, dir, hint = {}) {
  const rows = [];
  const add = (b, field, meaning) => rows.push({ bytes: spaced(b), field, meaning });
  add(p.bytes.slice(0, 2), 'Header', 'Every message starts with ff ff.');
  add([p.id], 'Motor ID', p.id === 0xfe ? 'fe means everybody (broadcast).' : `${motorLabel(p.id)}.`);
  add([p.len], 'Length', `${p.len} bytes follow: ${p.len - 2} parameter byte${p.len - 2 === 1 ? '' : 's'} plus the code and the checksum.`);
  if (p.code == null) return rows;
  if (dir === 'rx') {
    add([p.code], 'Error flags', p.code === 0 ? 'No error.' : `Faults: ${faultText(p.code & 63)}${p.code & ~63 ? ' (and bits this app does not name)' : ''}.`);
    if (p.params.length) {
      const reg = regFind(hint.addr);
      let meaning = `${p.params.length} data byte${p.params.length === 1 ? '' : 's'}.`;
      const shown = (v) => `${reg ? describeValue(reg.addr, v).text : v}${reg ? ` (${reg.name})` : ''}`;
      if (p.params.length === 1) meaning = `One data byte: ${shown(p.params[0])}.`;
      else if (p.params.length === 2) { const v = word(p.params[0], p.params[1]); meaning = `Two data bytes, low byte first, so they read as ${hex2(p.params[1])}${hex2(p.params[0])} hex = ${shown(v)}.`; }
      add(p.params, 'Data', meaning);
    }
  } else {
    const ins = INSTRUCTIONS[p.code];
    add([p.code], 'Instruction', ins ? `${ins[0]}: ${ins[1]}.` : 'An instruction this app does not name.');
    if (p.code === 0x02 && p.params.length >= 2) {
      const r = regInfo(p.params[0]);
      add([p.params[0]], 'Register', `Start at register ${p.params[0]}${r ? ` (${r.name})` : ''}.`);
      add([p.params[1]], 'Count', `Read ${p.params[1]} byte${p.params[1] === 1 ? '' : 's'}.`);
    } else if (p.code === 0x03 && p.params.length >= 2) {
      const r = regInfo(p.params[0]), data = p.params.slice(1);
      add([p.params[0]], 'Register', `Start at register ${p.params[0]}${r ? ` (${r.name})` : ''}.`);
      const v = data.length === 1 ? data[0] : data.length === 2 ? word(data[0], data[1]) : null;
      add(data, 'Value', v == null ? `${data.length} bytes to write.` : `Write ${v}${r ? ` = ${describeValue(r.addr, v).text}` : ''}${data.length === 2 ? ' (low byte first)' : ''}.`);
    } else if (p.params.length) add(p.params, 'Parameters', `${p.params.length} parameter byte${p.params.length === 1 ? '' : 's'}.`);
  }
  if (p.chk != null) add([p.chk], 'Checksum', p.checksumOk ? 'Adds up correctly, so the message arrived intact.' : `Does not add up (expected ${hex2(p.expected)}): the message may be damaged.`);
  else add([], 'Checksum', p.truncated ? 'The message ends early: the end of it is missing.' : 'Missing.');
  return rows;
}
/** One short line for a raw row. */
export function packetSummary(bytes, dir) {
  const { packets } = parsePackets(bytes);
  const p = packets[0];
  if (!p) return bytes.length ? `${bytes.length} bytes that do not start with ff ff` : 'no bytes';
  if (dir === 'rx') {
    const err = p.code === 0 ? 'no error' : `faults: ${faultText((p.code ?? 0) & 63)}`;
    return p.params.length ? `${motorLabel(p.id)} answered (${err}), data ${spaced(p.params)}` : `${motorLabel(p.id)} answered (${err})`;
  }
  if (p.code === 0x01) return `Ping ${motorLabel(p.id)}`;
  if (p.code === 0x02 && p.params.length >= 2) { const r = regInfo(p.params[0]); return `Ask ${motorLabel(p.id)} to read ${p.params[1]} byte${p.params[1] === 1 ? '' : 's'} at register ${p.params[0]}${r ? ` (${r.name})` : ''}`; }
  if (p.code === 0x03 && p.params.length >= 2) { const r = regInfo(p.params[0]); return `Tell ${motorLabel(p.id)} to write register ${p.params[0]}${r ? ` (${r.name})` : ''}`; }
  const ins = INSTRUCTIONS[p.code];
  return `${ins ? ins[0] : 'Instruction ' + hex2(p.code ?? 0)} to ${motorLabel(p.id)}`;
}

/* ---------- plain-language explanation of a trace entry ---------- */
// Returns paragraphs as tiny HTML (<b>, <code>) for ui.rich(). Everything from the backend is escaped.
const HTTP_WORDS = [
  [/^\/api\/state$/, 'the app asking for the live state of the arms (positions, motors answering). The dashboard does this twice a second.'],
  [/^\/api\/suite\/checklist/, 'the app asking which setup checks pass.'],
  [/^\/api\/suite\/info/, 'the app asking for its own version.'],
  [/^\/api\/suite\/settings/, 'reading or saving your settings.'],
  [/^\/api\/suite\/motors/, 'the Motor IDs / Test motors tools talking to the motors (scan, ping or wiggle).'],
  [/^\/api\/suite\/cameras/, 'the Cameras page.'],
  [/^\/api\/suite\/ports/, 'looking for the arm’s USB ports.'],
  [/^\/api\/calib\//, 'the Calibrate page telling the app what to do with the arm.'],
  [/^\/api\/teleop\//, 'starting or stopping teleoperation (the follower copying the leader).'],
  [/^\/api\/pp\//, 'the pick-and-place controls.'],
  [/^\/api\/suite\/trace/, 'the Inspector itself reading this list.'],
];
export const httpWords = (path) => (HTTP_WORDS.find(([re]) => re.test(String(path || ''))) || [])[1] || null;
const statusWords = (s) => (s >= 200 && s < 300 ? 'It worked.' : s >= 300 && s < 400 ? 'The app was pointed somewhere else (a redirect).' : s === 404 ? 'The app does not have anything at that address.' : s === 409 ? 'The app said “not right now” (for example the arm is busy with something else).' : s >= 400 && s < 500 ? 'The request was refused. The answer usually has a sentence saying why.' : s >= 500 ? 'The app itself had a problem while handling it.' : '');
export const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No content', 301: 'Moved', 302: 'Found (redirect)', 304: 'Not modified', 400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 409: 'Conflict', 422: 'Unprocessable', 429: 'Too many requests', 500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Timeout' };

/** Paragraphs (tiny HTML strings) explaining one entry. `ctx.pair` may carry the matching request {addr} for a raw reply. */
export function explainEntry(item, ctx = {}) {
  const out = [];
  if (!item) return out;
  if (item.kind === 'bus') {
    const m = motorLabel(item.id), r = regOf(item), op = item.op;
    if (op === 'ping') {
      out.push(`The app sent a <b>ping</b> to <b>${esc(m)}</b>: “are you there?” A ping only asks; it never moves anything.`);
      out.push(item.ok === false ? `<b>It did not answer.</b> ${esc(explainError(item.err).text)}` : 'The motor answered, so it is plugged in, powered and has this ID.');
      return out;
    }
    const regText = r ? `register ${r.addr}, <code>${esc(r.name)}</code>` : `register ${esc(item.addr ?? item.reg ?? '?')}`;
    if (isRead(op)) {
      out.push(`The app asked <b>${esc(m)}</b> ${r ? esc(r.ask) : 'for a value'} (${regText}).`);
      if (item.ok === false) {
        const ex = explainError(item.err);
        out.push(`<b>No usable answer${item.err ? `: ${esc(item.err)}` : ''}.</b> ${esc(ex.text)}`);
      } else if (item.value != null) {
        const d = describeValue(r?.addr ?? item.addr, item.value);
        out.push(`It answered <b>${esc(d.raw)}</b>.${d.plain ? ' ' + esc(d.plain) : ''}`);
      }
    } else if (isWrite(op)) {
      const d = describeValue(r?.addr ?? item.addr, item.value);
      out.push(`The app told <b>${esc(m)}</b> ${esc(d.tell)} (${regText}${item.value != null ? `, value ${esc(item.value)}` : ''}).`);
      if (d.plain) out.push(esc(d.plain));
      out.push(item.ok === false ? `<b>The motor did not confirm${item.err ? `: ${esc(item.err)}` : ''}.</b> ${esc(explainError(item.err).text)}` : 'The motor acknowledged it.');
    }
    if (r && POLL_ADDRS.has(r.addr) && isRead(op) && item.ok !== false) out.push('The app reads this about 10 times a second for every motor so the screen and the 3D arm stay live. That is normal, not a problem.');
    if (r?.addr === 65 && item.value) faultsOf(item.value & 63).forEach((f) => out.push(`<b>${esc(f.label)} fault.</b> ${esc(f.plain)}`));
    if (r) out.push(`<i>How to read register ${r.addr}: ${esc(r.how)}</i>`);
    return out;
  }
  if (item.kind === 'http') {
    const words = httpWords(item.path);
    out.push(`The page ${item.method === 'GET' ? 'asked' : 'told'} the app: <code>${esc(item.method)} ${esc(item.path)}</code>${words ? `, which is ${esc(words)}` : '.'}`);
    out.push(item.status ? `The app answered <b>${esc(item.status)} ${esc(STATUS_TEXT[item.status] || '')}</b>. ${esc(statusWords(item.status))}` : 'There was no answer.');
    out.push('This is the app’s own web API, the link between this page and the program on your computer. It is separate from the cable to the motors.');
    return out;
  }
  if (item.kind === 'log') {
    out.push(`A note the app wrote about itself${item.source ? ` (from <code>${esc(item.source)}</code>)` : ''}: <b>${esc(item.msg)}</b>`);
    out.push(item.level === 'error' ? '<b>This one is an error.</b> The app is telling you something did not work. Look at the entries just before it to see what led up to it.' : item.level === 'warn' ? 'This is a warning: the app carried on, but something deserves a look.' : 'This is only information.');
    return out;
  }
  if (item.kind === 'raw') {
    const bytes = hexBytes(item.hex);
    out.push(item.dir === 'tx' ? 'These are the exact bytes the app <b>sent</b> down the cable to the motors.' : 'These are the exact bytes the motors <b>sent back</b>.');
    out.push(`<b>${esc(packetSummary(bytes, item.dir))}.</b>`);
    out.push('Open the Raw bytes tab to see every byte named. Most people never need this level.');
  }
  return out;
}
