const sharedSheets = new WeakMap<Document, { sheet: CSSStyleSheet; cssText: string }>();

/**
 * Injects CSS text into a shared `CSSStyleSheet` on `document.adoptedStyleSheets`.
 * No-ops cleanly outside DOM environments or when Constructable Stylesheets are unsupported.
 */
export function injectCss(cssText: string): void {
  if (typeof document === 'undefined') return;
  try {
    const existing = sharedSheets.get(document);
    if (existing) {
      existing.cssText = `${existing.cssText}\n${cssText}`;
      existing.sheet.replaceSync(existing.cssText);
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sharedSheets.set(document, { sheet, cssText });
  } catch {
    // Minimal DOM mocks without Constructable Stylesheets support ignore stylesheet injection.
  }
}
