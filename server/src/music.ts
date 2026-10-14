/* Club music, shared: the server keeps each club's playlist on its own clock, so everyone online in a club hears the
   same track at the same point. A track plays PASSES times round its loop, then the next one starts XF seconds before
   the end (the clients crossfade). DJ booth requests queue a track next, or start it now. The loop lengths must match
   the client's CLUB_TRACKS (giantwood-scouts/index.html) and the files in music/. */
export const TRACKS: Record<string, number> = {   // loop length, seconds
  reach: 40, feelings: 39.5876, smooth: 37.2718,
  afrohouse: 64, mylove: 31.4754, dirtyhouse: 30.9677,
  whistle: 35.2529, amabeat: 33.9823, amatry: 34.9091,
  godown: 34.909, closer: 60, sunborn: 39.1742,
};
export const LISTS: Record<string, string[]> = {
  "Club Prestige": ["reach", "feelings", "smooth"],
  "Neon Lounge": ["afrohouse", "mylove", "dirtyhouse"],
  "The Lagoon Club": ["whistle", "amabeat", "amatry"],
  "Bluewave Beach Club": ["godown", "sunborn", "closer"],
};
export const PASSES = 2, XF = 4;
export const trackMs = (key: string) => TRACKS[key] * 1000 * PASSES;
