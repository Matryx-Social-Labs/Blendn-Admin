# Reviewing venue candidates

`candidates.sql` keeps what a filter can judge. This pass judges the rest, one row at a time:
is this a place adults in the city go to **meet people**? It is run by Claude agents over
chunks of `out/chunks/<city>/chunk=<n>/data_0.csv`, and a person reads a sample of every
city's result before anything is imported.

## Output

For input `out/chunks/<city>/chunk=<n>/data_0.csv`, write `out/decisions/<city>-<n>.csv` with
exactly these columns, one row per input row, same order:

```
source_id,keep,type,sports,reason
```

- `keep`: `1` or `0`.
- `type`: one of `pub_bar`, `brewery`, `lounge_rooftop`, `nightclub`, `live_music_venue`,
  `cafe`, `coworking`, `restaurant`. Start from the suggested `type`; change it only when it is wrong.
- `sports`: `1` if the place is a sports bar or is known for screening matches, else `0`.
- `reason`: at most eight words, no commas.

## Keep

- Pubs, bars, breweries and microbreweries, lounges, rooftops, cocktail bars, nightclubs,
  music and comedy venues, karaoke, hotel bars.
- Restaurants that are also a night out: resto-bars, gastropubs, "kitchen and bar" concepts,
  well-known dining-and-drinks places.
- Cafés people sit in and meet at: coffee chains (Café Coffee Day, Starbucks, Third Wave,
  Blue Tokai, Costa, Barista, The Coffee Bean) and proper independent cafés.
- Coworking spaces (WeWork, 91springboard, Awfis, independents).

## Drop

- Basic local liquor bars: "X Bar and Restaurant", "Family Restaurant and Bar", wine shops,
  permit rooms that are drinking dens rather than places to go out.
- Anything inside a private campus, office, hospital, or airport airside; office canteens;
  takeaway kiosks and tea stalls; bakeries, sweet shops, ice cream and juice counters.
- Members-only clubs (gymkhanas, old city clubs), banquet halls, event companies, DJs and
  bands, which are businesses rather than venues.
- Names that are an address, a person, or a city; places clearly pinned in the wrong city.
- A second row for a place already in the chunk: keep the higher-confidence one.

## When unsure

Keep it if `confidence` is 0.8 or more; drop it if below 0.7; between those, keep it only if
the name reads as a place to go out or sit. Do not look anything up on the web: judge from the
row and what you already know about the city.
