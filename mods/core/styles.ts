/**
 * Installs a stylesheet via Constructable Stylesheets when supported, with an
 * optional nonce-aware `<style>` element fallback.
 */
export function injectCss(cssText: string, allowStyleElementFallback = false): void {
  if (typeof document === 'undefined') return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  } catch {
    if (!allowStyleElementFallback) return;
  }

  const targetRoot = document.head ?? document.documentElement;
  if (!targetRoot) return;
  const existingStyle = document.querySelector('style[nonce]');
  if (existingStyle) {
    existingStyle.textContent = `${existingStyle.textContent ?? ''}${cssText}`;
    return;
  }
  const style = document.createElement('style');
  style.textContent = cssText;
  targetRoot.appendChild(style);
}
