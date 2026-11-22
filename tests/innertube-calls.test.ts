import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  findFeedbackToken,
  getFeedbackPanelTokens,
  requestNextAndNavigateChannel,
  sendFeedbackToken,
} from '../mods/core/innertube-calls.ts';

describe('innertube-calls error and fallback paths', () => {
  test('handles missing services, empty panels, lockupViewModel items, and rejections gracefully', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const origError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);

    t.after(() => {
      console.error = origError;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
    });

    // Missing _yttv services -> safe defaults.
    delete globals.window;
    requestNextAndNavigateChannel({ tileRenderer: { contentId: 'vid1' } });
    assert.deepEqual(await getFeedbackPanelTokens('p', 'params'), []);
    assert.equal(await sendFeedbackToken('tok'), null);

    // lockupViewModel channel nav without matching videoMetadataRenderer owner, plus error paths.
    const resolved: unknown[] = [];
    let shouldRejectIdentity = false;
    let shouldFailFetch = false;
    let returnEmptyPanel = true;

    const serviceMap = new Map<string, unknown>([
      [
        'CurrentIdentityService',
        {
          get: async () => {
            if (shouldRejectIdentity) throw new Error('Identity error');
            return { id: 'id-1' };
          },
        },
      ],
      [
        'KabukiInnerTubeClient',
        {
          fetch: (req: { path: string }) => ({
            subscribe: (onNext: (res: unknown) => void, onErr?: (e: unknown) => void) => {
              if (shouldFailFetch) {
                onErr?.(new Error('Network fail'));
                return;
              }
              if (req.path === '/youtubei/v1/next') {
                onNext(
                  returnEmptyPanel
                    ? {}
                    : {
                        contents: {
                          singleColumnWatchNextResults: {
                            results: {
                              results: {
                                contents: [{ itemSectionRenderer: { contents: [{ videoMetadataRenderer: {} }] } }],
                              },
                            },
                          },
                        },
                      }
                );
              } else if (req.path === '/youtubei/v1/get_panel') {
                onNext(
                  returnEmptyPanel
                    ? {}
                    : {
                        content: {
                          engagementPanelSectionListRenderer: {
                            content: {
                              listViewModel: {
                                listItems: [null, { listItemViewModel: { noToken: true } }],
                              },
                            },
                          },
                        },
                      }
                );
              }
            },
          }),
        },
      ],
    ]);

    globals.window = {
      _yttv: {
        services: { mappings: serviceMap },
        router: {
          instance: {
            resolveCommand: (cmd: unknown) => {
              resolved.push(cmd);
              return true;
            },
          },
        },
      },
    };

    // Missing listItems resolves []
    assert.deepEqual(await getFeedbackPanelTokens('p', 'params'), []);
    returnEmptyPanel = false;
    assert.deepEqual(await getFeedbackPanelTokens('p', 'params'), []);

    // lockupViewModel without videoId returns early; with videoId traverses safely without ownerRenderer.
    requestNextAndNavigateChannel({ lockupViewModel: {} });
    requestNextAndNavigateChannel({
      lockupViewModel: {
        contentId: 'lockup1',
        rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { params: 'p2' } } } } },
      },
    });
    await Promise.resolve();
    assert.equal(resolved.length, 0);

    // Fetch error callbacks & identity rejection are logged cleanly.
    shouldFailFetch = true;
    requestNextAndNavigateChannel({ tileRenderer: { contentId: 'vidErr' } });
    await Promise.resolve();
    await assert.rejects(() => getFeedbackPanelTokens('p', 'params'));
    await assert.rejects(() => sendFeedbackToken('tok'));

    shouldRejectIdentity = true;
    requestNextAndNavigateChannel({ tileRenderer: { contentId: 'vidIdErr' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(errors.length >= 2);
    assert.equal(findFeedbackToken(null), null);
  });
});
