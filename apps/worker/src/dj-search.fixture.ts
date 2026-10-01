/**
 * GET /dj/search as this repository defines it.
 *
 * `RadioProvider.djSearch` returns `Promise<unknown>` (`packages/providers/src/types.ts`).
 * The provider test body is `{ results, hasMore, ok }` (`providers.test.ts`).
 * Docs and `queueTrack` use string `id` and `title`, with optional `artist` and `album`.
 * `LibrarySong.path` is Navidrome `search3`, not this call. No duration and no filename
 * are defined. The string `id` is what `POST /dj/queue-track` sends. This app does not
 * know that id before search returns it, so it cannot be tied to the library file
 * just placed. Live SUB/WAVE OpenAPI was not fetched (`docs/RELEASE_CANDIDATE.md`).
 *
 * A match on these fields is artist + title only. It is not a file identity match.
 */
export type DjSearchHit = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
};

export type DjSearchResponse = {
  ok: true;
  hasMore: boolean;
  results: DjSearchHit[];
};

export const DJ_SEARCH_SAMPLE: DjSearchResponse = {
  ok: true,
  hasMore: false,
  results: [
    {
      id: "nd-song-1",
      title: "Don't Go (Original Mix)",
      artist: "Adam Beyer",
      album: "Beatport Top 100 Techno (Peak Time, Driving) April 2025",
    },
  ],
};

export function djSearchResponse(results: DjSearchHit[], hasMore = false): DjSearchResponse {
  return { ok: true, hasMore, results };
}
