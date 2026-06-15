// Injects identity flags into the page's main world so dApps that use the
// quick-detect path (window.freighter / window.aptopia) can find the wallet
// without going through the postMessage round-trip in @stellar/freighter-api.
//
// Both globals point at the same boolean — Aptopia presents itself as both
// itself and a Freighter-compatible wallet so legacy Stellar dApps that
// hard-code the freighter check continue to work after the rebrand.
//
// We use the inline-script-injection trick rather than world="MAIN" in the
// manifest because the v2 manifest does not understand the `world` field and
// we ship a shared content_scripts entry for both v2 and v3 manifests.

export const injectWalletGlobals = () => {
  // The page may not have a head yet at document_start — fall back to the
  // documentElement, which always exists once the parser has emitted <html>.
  const target = document.head || document.documentElement;
  if (!target) return;

  const s = document.createElement("script");
  s.textContent = `(function() {
    try {
      Object.defineProperty(window, 'aptopia', { value: true, configurable: false, writable: false });
    } catch (e) { /* already defined */ }
    try {
      Object.defineProperty(window, 'freighter', { value: true, configurable: false, writable: false });
    } catch (e) { /* already defined */ }
  })();`;
  target.appendChild(s);
  // Detach immediately — the property is now defined on the page's window
  // and the script element is just clutter in the DOM.
  s.remove();
};
