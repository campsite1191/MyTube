/**
 * Injects CSS text into `document.adoptedStyleSheets`.
 * No-ops cleanly outside DOM environments or when Constructable Stylesheets are unsupported.
 */
export function injectCss(cssText: string): void {
  if (typeof document === 'undefined') return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Minimal DOM mocks without Constructable Stylesheets support ignore stylesheet injection.
  }
}
