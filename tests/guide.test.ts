import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { transformGuideResponse } from '../mods/transforms/guide.ts';

describe('transformGuideResponse', () => {
  test('filters secondary guide sections, supports Shorts/icon fallbacks, and handles invalid payloads', () => {
    assert.equal(transformGuideResponse(null), null);
    assert.deepEqual(transformGuideResponse({ items: [] }), { items: [] });

    const payload = {
      items: [
        {
          guideSectionRenderer: {
            items: [
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
      ],
    };

    const out = transformGuideResponse(payload) as {
      items: Array<{ guideSectionRenderer?: { items: unknown[]; originalItems?: unknown[] } }>;
    };

    assert.equal(out.items[0]?.guideSectionRenderer?.items.length, 2);
    assert.equal(out.items[2]?.guideSectionRenderer?.originalItems?.length, 4);
    assert.equal(out.items[2]?.guideSectionRenderer?.items.length, 1);
  });

  test('[TDD Red: M5] transformGuideResponse does not retain unfiltered originalItems references on guide sections', () => {
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
});
