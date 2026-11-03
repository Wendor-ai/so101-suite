// The app's built-in defaults. This must stay identical to defaults/so101.defaults.json (the real backend reads that file);
// tests/js/mock.test.mjs checks the two are deep-equal. Change them in the JSON first, then copy here.
export const DEFAULTS = {
  serial: {
    baud: 1000000,
    scan_baud_rates: [1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400],
    motor_ids: { shoulder_pan: 1, shoulder_lift: 2, elbow_flex: 3, wrist_flex: 4, wrist_roll: 5, gripper: 6 },
  },
  calibration: {
    mid_ticks: 2047,
    ticks_per_turn: 4095,
    min_span_ticks: 150,
    wrist_roll_full_turn: true,
    follower_id: 'my_follower',
    leader_id: 'my_leader',
  },
  safety: {
    load_limit_pct: 70,
    wrist_roll_load_limit_pct: 85,
    temp_limit_c: 68,
    teleop_hz: 120,
    teleop_slew_ticks: 20,
    teleop_slew_sync_ticks: 2,
    confirm_before_move: true,
    speed_preset: 'gentle',
  },
  cameras: { width: 640, height: 480, fps: 30, fourcc: 'MJPG', jpeg_quality: 75, stale_after_s: 2.5 },
  server: { host: '127.0.0.1', port: 8000 },
  ui: {
    theme: 'auto',
    accent: 'orange',
    guide: 'beginner',
    units: 'deg',
    textSize: 'normal',
    reduceMotion: false,
    onboarded: false,
    calibrationPrompted: false,
  },
  adv: { rawLinks: false, modulesEnabled: true, logLevel: 'info', disabledModules: [], trace: false, traceRaw: false, traceMax: 5000 },
};

export default DEFAULTS;
