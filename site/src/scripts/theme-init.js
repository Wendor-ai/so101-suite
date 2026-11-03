// Runs in <head> before first paint: apply the saved theme (if any) and mark that JavaScript works.
(function () {
  var d = document.documentElement;
  try { var t = localStorage.getItem('so101-site-theme'); if (t === 'light' || t === 'dark') d.setAttribute('data-theme', t); } catch (e) {}
  d.classList.add('js');
})();
