// Facts used across the site. Keep claims here small and checkable.
export const REPO = 'https://github.com/Wendor-ai/so101-suite';
export const REPO_BLOB = `${REPO}/blob/main`;
export const REPO_TREE = `${REPO}/tree/main`;
export const ISSUES = `${REPO}/issues`;
export const SO_ARM100 = 'https://github.com/TheRobotStudio/SO-ARM100';
export const LEROBOT_SO101 = 'https://huggingface.co/docs/lerobot/so101';
export const LEROBOT = 'https://github.com/huggingface/lerobot';
export const THREEJS = 'https://threejs.org';

export const NAME = 'SO-101 Suite';
export const TAGLINE = 'From unopened box to a moving robot arm.';
export const DESCRIPTION =
  'A free, open-source web app that walks you through setting up, calibrating and learning your SO-101 robot arm. Try it in your browser, no install.';

export const NAV = [
  { href: '/features/', label: 'Features' },
  { href: '/get-started/', label: 'Get started' },
  { href: '/learn/', label: 'Learn' },
  { href: '/docs/', label: 'Docs' },
  { href: '/modules/', label: 'Modules' },
  { href: '/ai/', label: 'For AI agents' },
];

export const INSTALL = {
  unix: 'git clone https://github.com/Wendor-ai/so101-suite && cd so101-suite && ./setup.sh',
  windows: 'git clone https://github.com/Wendor-ai/so101-suite\ncd so101-suite\n.\\setup.ps1',
};

export const DISCLAIMER =
  'SO-101 Suite is an independent community project. It is not affiliated with, endorsed by, or sponsored by Hugging Face / LeRobot, The Robot Studio / SO-ARM100, or Feetech. Product and project names belong to their owners.';

export const FAQ = [
  {
    q: 'Do I need an arm to try it?',
    a: '<p>No. The <a href="/demo/">live demo</a> runs the real app in your browser with simulated hardware, and <a href="/learn/">Learn</a> explains every part of the arm in plain words. You only need an SO-101 when you want to move something for real.</p>',
  },
  {
    q: 'What does it cost?',
    a: '<p>The software is free and open source under the AGPL-3.0 licence. The robot hardware is separate and is not sold here. See the <a href="/get-started/">Get started</a> page for the official build guides.</p>',
  },
  {
    q: 'Do I need to know how to code?',
    a: '<p>No. You run one command and the app opens in your browser. Each screen says what to do next, and every unfamiliar word has a short explanation. If you do like code, the project is plain Python and plain JavaScript.</p>',
  },
  {
    q: 'Which computers does it run on?',
    a: '<p>macOS, Linux (including Raspberry Pi) and Windows. There is one setup command for each: <code>./setup.sh</code> for macOS and Linux, <code>.\\setup.ps1</code> for Windows.</p>',
  },
  {
    q: 'Does it send my data anywhere?',
    a: '<p>No. The app runs on your own computer and has no accounts and no telemetry. This website has no analytics and loads nothing from other sites.</p>',
  },
  {
    q: 'Do I need both a leader and a follower arm?',
    a: '<p>No. The follower is the arm that does the work. The leader is the arm you move by hand to drive it, and it is optional. You can add it any time.</p>',
  },
  {
    q: 'Is this the official SO-101 or LeRobot software?',
    a: '<p>No. It is an independent community project and is not affiliated with or endorsed by Hugging Face / LeRobot, The Robot Studio / SO-ARM100, or Feetech. It works alongside them, and the calibration file it saves is LeRobot-compatible. See <a href="/about/">About</a>.</p>',
  },
  {
    q: 'Can I train AI policies with it?',
    a: '<p>Training and recording robot-learning policies is the job of LeRobot, so this project links to it instead of copying it. The Suite gets your arm built, calibrated and working so that you are ready for that step.</p>',
  },
  {
    q: 'What is AGPL-3.0, in one sentence?',
    a: '<p>You can use, change and share the code for free, and if you share a modified version (including running it as an online service) you must share your changes under the same licence. This is a plain-language summary, not legal advice.</p>',
  },
];
