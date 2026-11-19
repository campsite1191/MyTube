import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildChaptersMarkerEntity, parseTimestamps } from '../mods/transforms/chapters.ts';

describe('chapters', () => {
  test('parseTimestamps parses m:ss and h:mm:ss lines', () => {
    const parsed = parseTimestamps('0:00 Intro\n1:23:45 Deep Dive\nnot a timestamp');
    assert.deepEqual(parsed, [
      { time: 0, name: 'Intro' },
      { time: (1 * 3600 + 23 * 60 + 45) * 1000, name: 'Deep Dive' },
    ]);
  });

  test('buildChaptersMarkerEntity returns null when description has no timestamps', () => {
    const entity = buildChaptersMarkerEntity(
      {
        videoDetails: { videoId: 'abc123', shortDescription: 'No chapters here' },
      },
      120_000
    );
    assert.equal(entity, null);
  });

  test('buildChaptersMarkerEntity builds macroMarkersListEntity from watchNext metadata', () => {
    const entity = buildChaptersMarkerEntity(
      {
        contents: {
          singleColumnWatchNextResults: {
            results: {
              results: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [
                        {
                          videoMetadataRenderer: {
                            videoId: 'vid1',
                            description: {
                              runs: [{ text: '0:00 Start\n1:00 Middle' }],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      120_000
    );

    assert.ok(entity);
    assert.equal(entity.entityKey, 'vid1-key');
    const markersList = entity.payload.macroMarkersListEntity.markersList as {
      markers: Array<{ durationMillis: string; thumbnailDetails: { thumbnails: Array<{ url: string; width: number; height: number }> } }>;
    };
    assert.equal(markersList.markers.length, 2);
    assert.equal(markersList.markers[0]?.durationMillis, '60000');
    assert.equal(markersList.markers[1]?.durationMillis, '60000');
    assert.equal(markersList.markers[0]?.thumbnailDetails.thumbnails[0]?.url, 'https://i.ytimg.com/vi/vid1/hq720.jpg');
    assert.equal(markersList.markers[0]?.thumbnailDetails.thumbnails[0]?.width, 1280);
  });
});
