import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildChaptersMarkerEntity,
  parseTimestamps,
  recordVideoDurationFromPayload,
} from '../mods/transforms/chapters.ts';

describe('chapters', () => {
  test('parseTimestamps parses m:ss and h:mm:ss lines, trims separators, and rejects out-of-range times', () => {
    const parsed = parseTimestamps(
      '0:00 - Intro\r\n0:99 Invalid Secs\n1:65:00 Invalid Mins\n1:23:45 | Deep Dive\nnot a timestamp'
    );
    assert.deepEqual(parsed, [
      { time: 0, name: 'Intro' },
      { time: (1 * 3600 + 23 * 60 + 45) * 1000, name: 'Deep Dive' },
    ]);
  });

  test('buildChaptersMarkerEntity returns null for missing chapters, single timestamps, or native chapters', () => {
    assert.equal(
      buildChaptersMarkerEntity(
        {
          videoDetails: { videoId: 'abc123', shortDescription: 'No chapters here' },
        },
        120_000
      ),
      null
    );

    assert.equal(
      buildChaptersMarkerEntity(
        {
          videoDetails: { videoId: 'abc123', shortDescription: '1:10 Only one shoutout' },
        },
        120_000
      ),
      null
    );

    assert.equal(
      buildChaptersMarkerEntity(
        {
          frameworkUpdates: {
            entityBatchUpdate: {
              mutations: [
                {
                  entityKey: 'native-key',
                  payload: {
                    macroMarkersListEntity: {
                      markersList: { markerType: 'MARKER_TYPE_CHAPTERS', markers: [] },
                    },
                  },
                },
              ],
            },
          },
          videoDetails: { videoId: 'abc123', shortDescription: '0:00 Intro\n1:00 Next' },
        },
        120_000
      ),
      null
    );
  });

  test('buildChaptersMarkerEntity reads videoDetails.lengthSeconds and DOM video duration, skipping invalid timestamps', (t) => {
    const fromPayload = buildChaptersMarkerEntity({
      videoDetails: {
        videoId: 'vidLen',
        lengthSeconds: '120',
        shortDescription: '0:00 Intro\n0:00 Duplicate\n0:45 Main\n0:30 Backwards\n3:00 Past End',
      },
    });
    assert.ok(fromPayload);
    const payloadMarkers = (
      fromPayload.payload.macroMarkersListEntity.markersList as {
        markers: Array<{ title: { simpleText: string }; startMillis: string; durationMillis: string }>;
      }
    ).markers;
    assert.deepEqual(
      payloadMarkers.map((m) => [m.title.simpleText, m.startMillis, m.durationMillis]),
      [
        ['Intro', '0', '45000'],
        ['Main', '45000', '75000'],
      ]
    );

    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });
    globals.document = {
      getElementsByTagName: (tag: string) => (tag === 'video' ? [{ duration: 90 }] : []),
    };

    const fromDom = buildChaptersMarkerEntity({
      videoDetails: {
        videoId: 'vidDom',
        shortDescription: '0:00 Start\n0:30 End',
      },
    });
    assert.ok(fromDom);
    const domMarkers = (
      fromDom.payload.macroMarkersListEntity.markersList as {
        markers: Array<{ durationMillis: string }>;
      }
    ).markers;
    assert.deepEqual(
      domMarkers.map((m) => m.durationMillis),
      ['30000', '60000']
    );
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
      markers: Array<{
        durationMillis: string;
        thumbnailDetails: { thumbnails: Array<{ url: string; width: number; height: number }> };
      }>;
    };
    assert.equal(markersList.markers.length, 2);
    assert.equal(markersList.markers[0]?.durationMillis, '60000');
    assert.equal(markersList.markers[1]?.durationMillis, '60000');
    assert.equal(markersList.markers[0]?.thumbnailDetails.thumbnails[0]?.url, 'https://i.ytimg.com/vi/vid1/hq720.jpg');
    assert.equal(markersList.markers[0]?.thumbnailDetails.thumbnails[0]?.width, 1280);
  });

  test('uses recorded /player duration or lengthText on /next instead of stale preview <video>.duration', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDocument = globals.document;
    t.after(() => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });
    // Simulate a stale 30s inline preview still loaded in <video> when /next for a 10-minute video parses
    globals.document = {
      getElementsByTagName: (tag: string) => (tag === 'video' ? [{ duration: 30 }] : []),
    };

    recordVideoDurationFromPayload({
      videoDetails: { videoId: 'longVid10m', lengthSeconds: '600' },
    });

    const entity = buildChaptersMarkerEntity({
      contents: {
        singleColumnWatchNextResults: {
          results: {
            results: {
              contents: [
                { alertRenderer: {} },
                {
                  itemSectionRenderer: {
                    contents: [
                      { spacerRenderer: {} },
                      {
                        videoMetadataRenderer: {
                          videoId: 'longVid10m',
                          description: {
                            runs: [{ text: '0:00 Intro\n2:00 Deep Dive\n8:00 Conclusion' }],
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
    });

    assert.ok(entity);
    const markers = (
      entity.payload.macroMarkersListEntity.markersList as {
        markers: Array<{ startMillis: string; durationMillis: string }>;
      }
    ).markers;
    assert.deepEqual(
      markers.map((m) => [m.startMillis, m.durationMillis]),
      [
        ['0', '120000'],
        ['120000', '360000'],
        ['480000', '120000'],
      ]
    );

    // Invalid clock formats, missing videoMetadataRenderer, and DOM duration === 0 return null cleanly.
    globals.document = {
      getElementsByTagName: () => [{ duration: 0 }],
    };
    const missingMeta = buildChaptersMarkerEntity({
      contents: {
        singleColumnWatchNextResults: {
          results: {
            results: {
              contents: [{ itemSectionRenderer: { contents: [{ unrelated: true }] } }],
            },
          },
        },
      },
      videoDetails: { videoId: 'noMetaVid' },
    });
    assert.equal(missingMeta, null);

    for (const badClock of ['0:00', '1:65', '2:70:10', 'not-a-clock']) {
      const res = buildChaptersMarkerEntity({
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
                            videoId: 'badLenVid',
                            lengthText: { simpleText: badClock },
                            description: { simpleText: '0:00 A\n1:00 B' },
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
      });
      assert.equal(res, null);
    }
  });
});
