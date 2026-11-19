interface TrustedTypePolicyFactoryLike {
  defaultPolicy?: unknown;
  createPolicy: (
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    }
  ) => unknown;
}

try {
  const trustedTypesFactory = (window as unknown as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes;
  if (trustedTypesFactory && !trustedTypesFactory.defaultPolicy) {
    trustedTypesFactory.createPolicy('default', {
      createHTML: (input: string) => input,
      createScript: (input: string) => input,
      createScriptURL: (input: string) => input,
    });
  }
} catch (_) {}

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
