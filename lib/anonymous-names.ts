import { db } from "./db"

const ADJECTIVES = [
  "Cosmic", "Neon", "Electric", "Golden", "Silver", "Crystal", "Mystic",
  "Lunar", "Solar", "Stellar", "Arctic", "Tropical", "Velvet", "Crimson",
  "Emerald", "Sapphire", "Ruby", "Amber", "Jade", "Coral", "Ivory",
  "Midnight", "Twilight", "Dawn", "Dusk", "Shadow", "Phantom", "Radiant",
  "Vivid", "Bold", "Brave", "Swift", "Gentle", "Fierce", "Noble", "Wild",
  "Silent", "Stormy", "Sunny", "Misty", "Frosty", "Blazing", "Gleaming",
  "Hidden", "Lucky", "Clever", "Witty", "Dreamy", "Daring", "Mellow",
  "Rustic", "Urban", "Wandering", "Floating", "Dancing", "Singing",
  "Laughing", "Glowing", "Sparkling", "Shining", "Burning", "Roaming",
  "Soaring", "Drifting", "Rolling", "Spinning", "Whirling", "Rising",
  "Falling", "Leaping", "Bouncing", "Tumbling", "Flowing", "Rushing",
  "Crashing", "Rumbling", "Humming", "Buzzing", "Chirping", "Howling",
]

const NOUNS = [
  "Panda", "Phoenix", "Dragon", "Falcon", "Tiger", "Wolf", "Eagle",
  "Dolphin", "Panther", "Jaguar", "Hawk", "Raven", "Owl", "Fox",
  "Bear", "Lion", "Stag", "Cobra", "Viper", "Crane", "Swan",
  "Otter", "Badger", "Lynx", "Moose", "Bison", "Gecko", "Mantis",
  "Heron", "Robin", "Finch", "Wren", "Lark", "Dove", "Parrot",
  "Toucan", "Pelican", "Puffin", "Penguin", "Koala", "Lemur",
  "Coyote", "Gazelle", "Cheetah", "Mustang", "Stallion", "Pegasus",
  "Griffin", "Unicorn", "Sphinx", "Kraken", "Hydra", "Titan",
  "Comet", "Nebula", "Quasar", "Nova", "Meteor", "Orbit", "Zenith",
  "Prism", "Echo", "Spark", "Flame", "Blaze", "Storm", "Thunder",
  "Frost", "Glacier", "Reef", "Oasis", "Summit", "Canyon", "Ridge",
  "Meadow", "Grove", "Brook", "River", "Tide", "Wave", "Dune",
]

export async function generateUniqueAnonymousName(chatGroupId: string): Promise<string> {
  // Fetch existing anonymous names in this group
  const existingMembers = await db.chat_group_members.findMany({
    where: { chat_group_id: chatGroupId },
    select: { anonymous_name: true },
  })

  const existingNames = new Set(
    existingMembers
      .map((m) => m.anonymous_name)
      .filter((n): n is string => n !== null)
  )

  // Try random combos up to 20 times
  for (let i = 0; i < 20; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
    const name = `${adj} ${noun}`
    if (!existingNames.has(name)) {
      return name
    }
  }

  // Fallback: append a number suffix
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  for (let suffix = 2; suffix < 1000; suffix++) {
    const name = `${adj} ${noun} ${suffix}`
    if (!existingNames.has(name)) {
      return name
    }
  }

  return `Attendee ${Date.now()}`
}
