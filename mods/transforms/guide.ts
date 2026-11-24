import { isRecord } from '../utils/type-guards.ts';

const SIDEBAR_ORDER = ['search', 'FEtopics', 'FEsubscriptions', 'FElibrary', 'FEtopics_news', 'SETTINGS'] as const;

const ALLOWED_SIDEBAR_CONTENTS = new Set<string>(SIDEBAR_ORDER);

interface GuideEntryRendererData {
  navigationEndpoint?: {
    browseEndpoint?: { browseId?: string };
    searchEndpoint?: unknown;
    applicationSettingsEndpoint?: unknown;
    reelWatchEndpoint?: unknown;
  };
  icon?: { iconType?: string };
  thumbnail?: unknown;
  formattedTitle?: { simpleText?: string };
}

function getGuideItemId(entry: GuideEntryRendererData | null | undefined): string | null {
  const ep = entry?.navigationEndpoint;
  if (ep?.applicationSettingsEndpoint || entry?.icon?.iconType === 'SETTINGS') return 'SETTINGS';
  if (ep?.browseEndpoint?.browseId) return ep.browseEndpoint.browseId;
  if (ep?.searchEndpoint) return 'search';
  if (ep?.reelWatchEndpoint || entry?.icon?.iconType === 'TAB_SHORTS' || entry?.icon?.iconType === 'SHORTS') {
    return 'FEshorts';
  }
  return entry?.icon?.iconType || null;
}

/**
 * Filters and reorders the YouTube TV navigation guide sidebar entries to the configured order.
 */
export function transformGuideResponse(r: unknown): unknown {
  if (!isRecord(r) || !Array.isArray(r.items)) return r;
  const firstEntry = isRecord(r.items[0]) ? r.items[0] : undefined;
  const firstSection = isRecord(firstEntry?.guideSectionRenderer) ? firstEntry.guideSectionRenderer : undefined;
  if (!firstSection || !Array.isArray(firstSection.items)) return r;

  const itemById = new Map<string, unknown>();
  for (const raw of firstSection.items) {
    const renderer = isRecord(raw) ? (raw.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
    if (!renderer || renderer.thumbnail) continue;
    const id = getGuideItemId(renderer);
    if (id && ALLOWED_SIDEBAR_CONTENTS.has(id) && !itemById.has(id)) {
      itemById.set(id, raw);
    }
  }

  for (const rawSection of r.items) {
    if (!isRecord(rawSection)) continue;
    const section = isRecord(rawSection.guideSectionRenderer) ? rawSection.guideSectionRenderer : undefined;
    if (!section || !Array.isArray(section.items)) continue;
    if (section === firstSection) {
      section.items = SIDEBAR_ORDER.flatMap((id) => {
        const entry = itemById.get(id);
        return entry ? [entry] : [];
      });
    } else {
      section.items = section.items.filter((entry) => {
        const item = isRecord(entry) ? (entry.guideEntryRenderer as GuideEntryRendererData | undefined) : undefined;
        if (!item || item.thumbnail) return false;
        const itemId = getGuideItemId(item);
        return Boolean(itemId && ALLOWED_SIDEBAR_CONTENTS.has(itemId));
      });
    }
  }

  return r;
}
