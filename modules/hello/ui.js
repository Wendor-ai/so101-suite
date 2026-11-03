// UI of the hello module: an ES module the Suite imports from /suite/modules/hello/ui.js.
// It exports one page: { id, title, icon, group, render(root, ctx) -> cleanup|void }.
// Plain DOM only, so you can see exactly what a module needs.
export default {
  id: 'hello',
  title: 'Hello',
  icon: 'hand',
  group: 'modules',
  render(root, ctx) {
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'card';
    const h = document.createElement('h2');
    h.textContent = 'Hello from a module';
    const p = document.createElement('p');
    p.textContent = 'This page and its backend live in modules/hello. Press the button to call the backend.';
    const out = document.createElement('p');
    const btn = document.createElement('button');
    btn.textContent = 'Say hello';
    btn.addEventListener('click', async () => {
      try {
        const r = await ctx.api.post('/api/m/hello/greet', { name: 'robot builder' });
        out.textContent = `${r.message} Arms connected: ${r.arms_connected}.`;
      } catch (e) {
        out.textContent = e.message;
      }
    });
    box.append(h, p, btn, out);
    root.append(box);
  },
};
