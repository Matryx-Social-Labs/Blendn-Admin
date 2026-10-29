-- Every member of an event's room has a pseudonym (SCRUM-887, owner ruling 2026-10-28).
--
-- Hosts see people only by their room pseudonym. Check-in has always minted one
-- (`claimAnonymousName`, lib/check-in-core.ts), but member rows written before it
-- did have none: staging held two checked-in members of an event's room with a
-- NULL `anonymous_name`, one of them with sixteen messages. Every host surface
-- shows them as "Attendee", which identifies nobody and names nobody either.
--
-- Each gets an `Adjective Noun` from the app's own word lists
-- (lib/anonymous-names.ts, copied below), drawn until it is free in its room, as
-- `generateUniqueAnonymousName` does: `@@unique([chat_group_id, anonymous_name])`
-- holds. After twenty taken draws a number is added, as the app's fallback does.
-- Members only: the host's own seat (`admin`) is named "Host", not a pseudonym.
-- Any NULL-named member of an event's room, checked in or since left, so a
-- returning one is not a nameless row. No board-derived preference
-- (`preferredPseudonymFor` is keyed on the server's secret): these rows
-- predate the board.
--
-- Safe beside a release still serving: the UPDATE only names a row still
-- NULL (a check-in may have named it meanwhile), and a name taken between the
-- probe and the write is drawn again rather than failing the deploy.
--
-- Wrapped: `migrate deploy` applies statement by statement. A handful of rows.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  adjectives text[] := ARRAY[
    'Cosmic', 'Neon', 'Electric', 'Golden', 'Silver', 'Crystal', 'Mystic', 'Lunar', 'Solar', 'Stellar',
    'Arctic', 'Tropical', 'Velvet', 'Crimson', 'Emerald', 'Sapphire', 'Ruby', 'Amber', 'Jade', 'Coral',
    'Ivory', 'Midnight', 'Twilight', 'Dawn', 'Dusk', 'Shadow', 'Phantom', 'Radiant', 'Vivid', 'Bold',
    'Brave', 'Swift', 'Gentle', 'Fierce', 'Noble', 'Wild', 'Silent', 'Stormy', 'Sunny', 'Misty',
    'Frosty', 'Blazing', 'Gleaming', 'Hidden', 'Lucky', 'Clever', 'Witty', 'Dreamy', 'Daring', 'Mellow',
    'Rustic', 'Urban', 'Wandering', 'Floating', 'Dancing', 'Singing', 'Laughing', 'Glowing', 'Sparkling', 'Shining',
    'Burning', 'Roaming', 'Soaring', 'Drifting', 'Rolling', 'Spinning', 'Whirling', 'Rising', 'Falling', 'Leaping',
    'Bouncing', 'Tumbling', 'Flowing', 'Rushing', 'Crashing', 'Rumbling', 'Humming', 'Buzzing', 'Chirping', 'Howling'
  ];
  nouns text[] := ARRAY[
    'Panda', 'Phoenix', 'Dragon', 'Falcon', 'Tiger', 'Wolf', 'Eagle', 'Dolphin', 'Panther', 'Jaguar',
    'Hawk', 'Raven', 'Owl', 'Fox', 'Bear', 'Lion', 'Stag', 'Cobra', 'Viper', 'Crane',
    'Swan', 'Otter', 'Badger', 'Lynx', 'Moose', 'Bison', 'Gecko', 'Mantis', 'Heron', 'Robin',
    'Finch', 'Wren', 'Lark', 'Dove', 'Parrot', 'Toucan', 'Pelican', 'Puffin', 'Penguin', 'Koala',
    'Lemur', 'Coyote', 'Gazelle', 'Cheetah', 'Mustang', 'Stallion', 'Pegasus', 'Griffin', 'Unicorn', 'Sphinx',
    'Kraken', 'Hydra', 'Titan', 'Comet', 'Nebula', 'Quasar', 'Nova', 'Meteor', 'Orbit', 'Zenith',
    'Prism', 'Echo', 'Spark', 'Flame', 'Blaze', 'Storm', 'Thunder', 'Frost', 'Glacier', 'Reef',
    'Oasis', 'Summit', 'Canyon', 'Ridge', 'Meadow', 'Grove', 'Brook', 'River', 'Tide', 'Wave',
    'Dune'
  ];
  r record;
  candidate text;
  tries int;
BEGIN
  FOR r IN
    SELECT m.chat_group_id, m.user_id
      FROM "chat_group_members" m
      JOIN "chat_groups" g ON g."id" = m."chat_group_id"
     WHERE g."kind" = 'event' AND m."role" = 'member' AND m."anonymous_name" IS NULL
  LOOP
    tries := 0;
    LOOP
      candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
        || ' ' || nouns[1 + floor(random() * array_length(nouns, 1))::int]
        || CASE WHEN tries >= 20 THEN ' ' || (tries - 18)::text ELSE '' END;
      tries := tries + 1;
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM "chat_group_members" WHERE "chat_group_id" = r.chat_group_id AND "anonymous_name" = candidate
      );
      BEGIN
        UPDATE "chat_group_members" SET "anonymous_name" = candidate
         WHERE "chat_group_id" = r.chat_group_id AND "user_id" = r.user_id AND "anonymous_name" IS NULL;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Taken since the probe: draw again.
      END;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
