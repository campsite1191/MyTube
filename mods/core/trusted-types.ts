// Attach the active CSP nonce onto dynamically created `<style>` fallback elements
// without claiming `trustedTypes.createPolicy('default', ...)` at document-start,
// which would conflict if YouTube TV registers its own default policy.
type CreateElementFn = (this: Document, tagName: string, options?: ElementCreationOptions) => HTMLElement;

export function installTrustedTypesNonceHook(
  docProto: Pick<Document, 'createElement'> | undefined = typeof Document !== 'undefined'
    ? Document.prototype
    : undefined,
  fallbackDoc: Document | undefined = typeof document !== 'undefined' ? document : undefined
): () => void {
  if (!docProto || typeof docProto.createElement !== 'function') {
    return () => {};
  }

  let cachedNonce = '';
  const originalCreateElement = docProto.createElement as CreateElementFn;
  docProto.createElement = function (this: Document, tagName: string, options?: ElementCreationOptions): HTMLElement {
    const element = originalCreateElement.call(this, tagName, options);
    if (
      typeof tagName === 'string' &&
      tagName.length === 5 &&
      (tagName === 'style' || tagName.toLowerCase() === 'style') &&
      !element.nonce
    ) {
      if (!cachedNonce) {
        const queryRoot = typeof this?.querySelector === 'function' ? this : fallbackDoc;
        const nonceSourceElement = queryRoot?.querySelector?.<HTMLStyleElement | HTMLScriptElement>(
          'style[nonce], script[nonce]'
        );
        if (nonceSourceElement?.nonce) cachedNonce = nonceSourceElement.nonce;
      }
      if (cachedNonce) element.nonce = cachedNonce;
    }
    return element;
  } as typeof Document.prototype.createElement;

  return () => {
    docProto.createElement = originalCreateElement;
  };
}

if (typeof Document !== 'undefined' && typeof Document.prototype?.createElement === 'function') {
  installTrustedTypesNonceHook();
}
