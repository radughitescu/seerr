export type ShowSeasons = {
  seasons: { season_number: number; episode_count: number }[];
};

export function requestableSeasons(show: ShowSeasons): number[] {
  return show.seasons
    .filter((season) => season.season_number !== 0 && season.episode_count > 0)
    .map((season) => season.season_number);
}
