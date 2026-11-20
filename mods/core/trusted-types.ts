// Attach the active CSP nonce onto dynamically created `<style>` fallback elements
// without claiming `trustedTypes.createPolicy('default', ...)` at document-start,
// which would conflict if YouTube TV registers its own default policy.
try {
  let cachedNonce = '';
  type CreateElementFn = (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions
  ) => HTMLElement;
  const originalCreateElement = Document.prototype.createElement as CreateElementFn;
  Document.prototype.createElement = function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions
  ): HTMLElement {
    const element = originalCreateElement.call(this, tagName, options);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'style' && !element.nonce) {
      if (!cachedNonce) {
        const nonceSourceElement = document.querySelector<HTMLStyleElement | HTMLScriptElement>(
          'style[nonce], script[nonce]'
        );
        if (nonceSourceElement?.nonce) cachedNonce = nonceSourceElement.nonce;
      }
      if (cachedNonce) element.nonce = cachedNonce;
    }
    return element;
  } as typeof Document.prototype.createElement;
} catch (_) {}
