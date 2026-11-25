import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { transformGuideResponse } from '../../mods/transforms/guide.ts';

describe('transformGuideResponse', () => {
  test('filters secondary guide sections, supports Shorts/icon fallbacks, and handles invalid payloads', () => {
    assert.equal(transformGuideResponse(null), null);
    assert.deepEqual(transformGuideResponse({ items: [] }), { items: [] });

    const payload = {
      items: [
        {
          guideSectionRenderer: {
            items: [
              null,
              { guideEntryRenderer: {} },
              { guideEntryRenderer: { icon: { iconType: 'TAB_SHORTS' } } },
              { guideEntryRenderer: { icon: { iconType: 'SHORTS' } } },
              { guideEntryRenderer: { icon: { iconType: 'SETTINGS' } } },
              { guideEntryRenderer: { icon: { iconType: 'UNKNOWN_ICON' } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
            ],
          },
        },
        null,
        {
          guideSectionRenderer: {
            items: [
              null,
              { guideEntryRenderer: { thumbnail: { thumbnails: [] }, icon: { iconType: 'SETTINGS' } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEsubscriptions' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtrending' } } } },
            ],
          },
        },
        { unrelatedSection: {} },
        { guideSectionRenderer: { items: 'invalid' } },
      ],
    };

    const out = transformGuideResponse(payload) as {
      items: Array<{ guideSectionRenderer?: { items: unknown[]; originalItems?: unknown[] } }>;
    };

    assert.equal(out.items[0]?.guideSectionRenderer?.items.length, 2);
    assert.equal('originalItems' in (out.items[2]?.guideSectionRenderer ?? {}), false);
    assert.equal(out.items[2]?.guideSectionRenderer?.items.length, 1);
  });

  test('[M5] transformGuideResponse does not retain unfiltered originalItems references on guide sections', () => {
    const section = {
      items: [
        { guideEntryRenderer: { icon: { iconType: 'TAB_SHORTS' } } },
        { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
      ],
    };
    transformGuideResponse({
      items: [{ guideSectionRenderer: section }],
    });
    assert.equal('originalItems' in section, false);
  });

  test('keeps only Search, Home, Subscriptions, Library, News, Settings in exact order', () => {
    const payload = {
      items: [
        {
          guideSectionRenderer: {
            items: [
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_music' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics_news' } } } },
              { guideEntryRenderer: { navigationEndpoint: { reelWatchEndpoint: {} } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FElibrary' } } } },
              { guideEntryRenderer: { navigationEndpoint: { applicationSettingsEndpoint: {} } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEsubscriptions' } } } },
              { guideEntryRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } } } },
              { guideEntryRenderer: { navigationEndpoint: { searchEndpoint: {} } } },
              {
                guideEntryRenderer: {
                  thumbnail: { thumbnails: [{ url: 'https://example.com/avatar.jpg' }] },
                  navigationEndpoint: { browseEndpoint: { browseId: 'UCchannel123' } },
                },
              },
            ],
          },
        },
      ],
    };

    const result = transformGuideResponse(payload) as typeof payload;
    const sectionItems = result.items[0]?.guideSectionRenderer.items ?? [];
    const ids = sectionItems.map((entry) => {
      const ep = entry.guideEntryRenderer?.navigationEndpoint as
        | {
            browseEndpoint?: { browseId?: string };
            searchEndpoint?: unknown;
            applicationSettingsEndpoint?: unknown;
          }
        | undefined;
      if (ep?.applicationSettingsEndpoint) return 'SETTINGS';
      return ep?.browseEndpoint?.browseId ?? (ep?.searchEndpoint ? 'search' : '');
    });

    assert.deepEqual(ids, ['search', 'FEtopics', 'FEsubscriptions', 'FElibrary', 'FEtopics_news', 'SETTINGS']);
  });
});
