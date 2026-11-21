import { isRecord } from '../utils/type-guards.ts';

const SIDEBAR_ORDER = [
  'search',
  'FEtopics',
  'FEsubscriptions',
  'FElibrary',
  'FEtopics_music',
  'FEtopics_movies',
  'FEtopics_live',
  'FEtopics_gaming',
  'FEtopics_news',
  'FEtopics_sports',
  'FEtopics_podcasts',
] as const;

const DISABLED_SIDEBAR_CONTENTS = new Set<string>([
  'FEtopics_music',
  'FEtopics_movies',
  'FEtopics_live',
  'FEtopics_gaming',
  'FEtopics_sports',
  'FEtopics_podcasts',
]);

interface GuideEntryRendererData {
  navigationEndpoint?: {
    browseEndpoint?: { browseId?: string };
    searchEndpoint?: unknown;
    reelWatchEndpoint?: unknown;
  };
  icon?: { iconType?: string };
  thumbnail?: unknown;
  formattedTitle?: { simpleText?: string };
}

function getGuideItemId(entry: GuideEntryRendererData | null | undefined): string | null {
  const ep = entry?.navigationEndpoint;
  if (ep?.browseEndpoint?.browseId) return ep.browseEndpoint.browseId;
  if (ep?.searchEndpoint) return 'search';
  if (ep?.reelWatchEndpoint || entry?.icon?.iconType === 'TAB_SHORTS' || entry?.icon?.iconType === 'SHORTS') {
    return 'FEshorts';
  }
  return entry?.icon?.iconType || null;
}

export function transformGuideResponse(r: unknown): unknown {
  if (!isRecord(r) || !Array.isArray(r.items)) return r;
  const firstEntry = isRecord(r.items[0]) ? r.items[0] : undefined;
  const firstSection = isRecord(firstEntry?.guideSectionRenderer) ? firstEntry.guideSectionRenderer : undefined;
  if (!firstSection || !Array.isArray(firstSection.items)) return r;

  const copiedItems: unknown[] = [...firstSection.items];
  const indexById = new Map<string, number>();
  for (let idx = 0; idx < copiedItems.length; idx++) {
    const raw = copiedItems[idx];
    const renderer = isRecord(raw) ? (raw.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
    const id = getGuideItemId(renderer);
    if (id && !indexById.has(id)) {
      indexById.set(id, idx);
    }
  }

  const orderedItems: unknown[] = [];
  const placed = new Set<number>();
  for (const browseId of SIDEBAR_ORDER) {
    const index = indexById.get(browseId);
    if (index !== undefined) {
      orderedItems.push(copiedItems[index]);
      placed.add(index);
    }
  }
  copiedItems.forEach((item, index) => {
    if (!placed.has(index)) orderedItems.push(item);
  });
  firstSection.items = orderedItems;

  for (const rawSection of r.items) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.guideSectionRenderer) ? rawSection.guideSectionRenderer : undefined;
    if (!section || !Array.isArray(section.items)) continue;
    section.originalItems = section.items.slice();
    for (let j = section.items.length - 1; j >= 0; j--) {
      const entry = section.items[j];
      const item = isRecord(entry) ? (entry.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
      if (!item) continue;
      const itemId = getGuideItemId(item);
      if ((itemId && DISABLED_SIDEBAR_CONTENTS.has(itemId)) || item.thumbnail) {
        section.items.splice(j, 1);
      }
    }
  }

  return r;
}
