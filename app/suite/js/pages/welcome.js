// Welcome: route a person by their situation. Three honest choices, nothing locked in.
import { h, icon, callout } from '../ui.js';
import { api } from '../api.js';

const choice = (ic, title, text, href, go) =>
  h('a', { class: 'card choice', href },
    h('div', { class: 'big-ico' }, icon(ic)), h('h3', {}, title), h('p', {}, text), h('div', { class: 'go' }, go, icon('arrow')));

export default {
  id: 'welcome', title: 'Welcome',
  render(root) {
    root.append(h('div', { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { textAlign: 'center', alignItems: 'center' } },
        h('div', { class: 'eyebrow' }, 'Welcome to SO-101 Suite'),
        h('h1', {}, 'Where are you with your SO-101?'),
        h('p', { class: 'lead' }, 'Pick the closest one. You can change your mind any time. Nothing is locked in.')),
      h('div', { class: 'grid grid-3' },
        choice('cube', 'I just unboxed it', 'A box of parts? First we give each motor its ID (while it’s still loose), then we build it one joint at a time, with pictures.', '#/motors', 'Start with the motors'),
        choice('plug', 'My arm is built', 'Let’s find your arm, check every connection, set the motor IDs and calibrate it.', '#/setup', 'Check my setup'),
        choice('book', 'I’m just looking around', 'Meet the arm in 3D and learn how it works. You don’t need any hardware.', '#/learn/meet-your-arm', 'Take the tour')),
      api.demo ? callout('tip', 'This is a <b>demo</b>: the arms and cameras are simulated, so you can click everything safely. Nothing leaves your browser.', 'Try anything') : null,
      h('p', { class: 'muted', style: { textAlign: 'center' } }, 'Already set up? ', h('a', { href: '#/control' }, 'Go straight to Control'), '.')));
  },
};
