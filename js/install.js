/* PWA install (Feature 10). Tools > Install app: uses the browser's install prompt when it offers one
 * (Chrome/Edge/Android), shows Add-to-Home-Screen steps on iPhone/iPad Safari, and says when the app
 * is already installed. Never claims installability the browser hasn't reported. */
(function () {
  "use strict";
  const T = window.mfaTools;
  let deferred = null, installed = false;
  const standalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const el = T.addSection({ id: "toolInstall", title: "📲 Install app", order: 95 });
  function render() {
    let h;
    if (standalone() || installed) h = `<p>Installed — you're using the app version. It opens from your home screen or app list.</p>`;
    else if (deferred) h = `<p>Add Mike's Fishing App to your home screen or app list. Saved lakes keep working offline.</p>
      <div class="tool-row"><button type="button" class="tool-btn" id="btnInstallApp" aria-label="Install app">📲 Install app</button></div>`;
    else if (ios) h = `<p>On iPhone or iPad: tap the <strong>Share</strong> button in Safari, then <strong>Add to Home Screen</strong>.</p>`;
    else h = `<p>Your browser hasn't offered installation on this page yet. In Chrome or Edge use the browser menu → <strong>Install app</strong> / <strong>Add to Home screen</strong>; in Safari use Share → <strong>Add to Home Screen</strong> (iOS) or File → <strong>Add to Dock</strong> (Mac).</p>`;
    el.innerHTML = h;
    const b = el.querySelector("#btnInstallApp");
    if (b) b.onclick = async () => {
      const d = deferred; deferred = null;
      d.prompt();
      try { const c = await d.userChoice; if (c && c.outcome === "accepted") installed = true; } catch (_) {}
      render();
    };
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; render(); });
  window.addEventListener("appinstalled", () => { installed = true; deferred = null; render(); });
  render();
  window.mfaInstall = { state: () => ({ standalone: standalone(), canPrompt: !!deferred, installed, ios }) };
})();
