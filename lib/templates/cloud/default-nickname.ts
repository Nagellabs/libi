/**
 * The public nickname every creator starts with: "<Adjective> <Animal> <NNNN>",
 * e.g. "Brave Otter 4821". Stored with the creator identity when it is made
 * (lib/db/settings.ts), so nobody has to invent a name before their first
 * publish; the user renames it whenever they like ("Publishing as" on the
 * Templates page, Settings → General, or `libi.publish_template({ nickname })`).
 *
 * Nicknames are not unique on the site — authors are told apart by authorId —
 * so the number only keeps two strangers from looking like one person:
 * ~170 × ~160 × 9000 ≈ 250 million combinations.
 *
 * The word lists are curated, not scraped: family-friendly, ASCII, one Title
 * Case word each, nothing that reads as an insult, a slur or innuendo in any
 * pairing, nothing political, and no brand or product name (hence no Jaguar,
 * Puma, Mustang, Dove, Lynx, Fox, Red, Prime ...). A test holds the lists to
 * that shape and walks every pairing against NICKNAME_PATTERN and the 32-char
 * limit — add a word there, not just here.
 */
import { randomInt } from "node:crypto";

export const NICKNAME_ADJECTIVES = [
  "Agile", "Amber", "Amiable", "Ample", "Artful", "Balmy", "Blissful", "Bold", "Bouncy", "Brave",
  "Breezy", "Bright", "Brisk", "Bubbly", "Buoyant", "Calm", "Candid", "Careful", "Chatty", "Cheerful",
  "Chipper", "Clever", "Coral", "Cosmic", "Cozy", "Crisp", "Curious", "Daring", "Dapper", "Dazzling",
  "Dreamy", "Dynamic", "Eager", "Earnest", "Easygoing", "Electric", "Elegant", "Epic", "Fabulous",
  "Fancy", "Fearless", "Festive", "Fleet", "Fluffy", "Flying", "Fresh", "Friendly", "Frosty", "Funky",
  "Gallant", "Genial", "Gentle", "Giddy", "Gifted", "Glad", "Gleeful", "Glowing", "Golden", "Graceful",
  "Grand", "Grateful", "Groovy", "Handy", "Happy", "Hardy", "Hearty", "Helpful", "Heroic", "Honest",
  "Hopeful", "Humble", "Jaunty", "Jazzy", "Jolly", "Jovial", "Joyful", "Jubilant", "Keen", "Kind",
  "Kindly", "Laughing", "Lively", "Lofty", "Loyal", "Lucky", "Luminous", "Lunar", "Magic", "Majestic",
  "Mellow", "Merry", "Mindful", "Misty", "Modest", "Mystic", "Neat", "Nifty", "Nimble", "Noble",
  "Patient", "Peaceful", "Peppy", "Pleasant", "Plucky", "Plush", "Polished", "Polite",
  "Quaint", "Quick", "Quiet", "Quirky", "Radiant", "Rapid", "Ready", "Regal", "Relaxed", "Resolute",
  "Robust", "Rosy", "Rugged", "Rustic", "Savvy", "Scenic", "Serene", "Sharp", "Shiny", "Silent",
  "Silky", "Silver", "Sincere", "Sleek", "Sleepy", "Smiley", "Smooth", "Snappy", "Snowy", "Snug",
  "Solar", "Sparkly", "Speedy", "Spirited", "Splendid", "Spry", "Steady", "Stellar",
  "Sturdy", "Sublime", "Sunlit", "Sunny", "Swift", "Thankful", "Thrifty", "Tidy", "Timely", "Tiny",
  "Tranquil", "Trusty", "Twinkly", "Upbeat", "Valiant", "Velvet", "Verdant", "Vibrant", "Violet", "Vivid",
  "Wandering", "Warm", "Whimsical", "Windy", "Wise", "Witty", "Zany", "Zesty", "Zippy",
] as const;

export const NICKNAME_ANIMALS = [
  "Aardvark", "Albatross", "Alpaca", "Anteater", "Antelope", "Armadillo", "Axolotl", "Badger", "Barracuda", "Bison",
  "Bluebird", "Buffalo", "Bumblebee", "Butterfly", "Canary", "Capybara", "Caribou", "Chameleon",
  "Cheetah", "Chickadee", "Chinchilla", "Chipmunk", "Cicada", "Condor", "Coyote", "Crane", "Cricket",
  "Cuttlefish", "Deer", "Dingo", "Dolphin", "Dormouse", "Dragonfly", "Duck", "Duckling", "Egret", "Elk",
  "Emu", "Falcon", "Fawn", "Ferret", "Finch", "Firefly", "Flamingo", "Foal", "Gazelle", "Gecko",
  "Gerbil", "Gibbon", "Giraffe", "Goldfinch", "Goldfish", "Gopher", "Grasshopper", "Guppy",
  "Hare", "Hedgehog", "Heron", "Hummingbird", "Ibex", "Iguana", "Jackrabbit", "Jellyfish",
  "Kangaroo", "Kestrel", "Kingfisher", "Kiwi", "Koala", "Kookaburra", "Kudu", "Ladybug", "Lamb",
  "Lark", "Lemur", "Leopard", "Lion", "Lobster", "Lorikeet", "Macaw", "Magpie", "Manatee",
  "Mantis", "Marlin", "Marmot", "Meerkat", "Minnow", "Moose", "Moth", "Narwhal", "Newt", "Nightingale",
  "Numbat", "Ocelot", "Octopus", "Opossum", "Orca", "Oriole", "Osprey", "Ostrich", "Otter", "Owl",
  "Panda", "Pangolin", "Parakeet", "Parrot", "Pelican", "Penguin", "Pheasant", "Platypus", "Porcupine",
  "Porpoise", "Puffin", "Puppy", "Quail", "Quetzal", "Quokka", "Rabbit", "Raccoon", "Raven", "Reindeer",
  "Robin", "Salamander", "Sandpiper", "Seahorse", "Seal", "Skylark", "Snail", "Sparrow", "Squid", "Squirrel",
  "Starfish", "Starling", "Stork", "Swan", "Tadpole", "Tamarin", "Tapir", "Tiger", "Toucan",
  "Tortoise", "Turtle", "Walrus", "Warbler", "Whale", "Wildcat", "Wolf", "Wombat", "Wren", "Yak",
  "Zebra", "Beluga", "Bluejay", "Koi", "Pika", "Stoat", "Tern", "Vole", "Wallaby",
  "Cormorant", "Dugong", "Lovebird", "Pony", "Muskox",
] as const;

/** The number's range, inclusive: always four digits. */
export const NICKNAME_NUMBER_MIN = 1000;
export const NICKNAME_NUMBER_MAX = 9999;

/**
 * Numbers a default never carries: it goes out as the user's PUBLIC name, and
 * they never picked it. Known hate codes (14/88 and their combinations, 1818,
 * 2316 "WP", 1312 "ACAB"), crude or joke ones (6969, 8008, 1337, 420x, 6666),
 * and — as the cheap, safe side — any number containing "88" at all.
 */
const EXCLUDED_NUMBERS = new Set([1312, 1337, 1414, 1418, 1441, 1814, 1818, 2316, 5318, 6666, 6969, 8008, 8014, 8814]);

export function isExcludedNicknameNumber(n: number): boolean {
  return EXCLUDED_NUMBERS.has(n) || String(n).includes("88") || /^420\d$/.test(String(n));
}

/** A fresh default nickname. Every draw comes from node:crypto — never Math.random. */
export function generateDefaultNickname(): string {
  const adjective = NICKNAME_ADJECTIVES[randomInt(NICKNAME_ADJECTIVES.length)];
  const animal = NICKNAME_ANIMALS[randomInt(NICKNAME_ANIMALS.length)];
  let number = randomInt(NICKNAME_NUMBER_MIN, NICKNAME_NUMBER_MAX + 1);
  // Redraw on an excluded number: ~3 % of the range, so a second draw nearly always lands.
  while (isExcludedNicknameNumber(number)) number = randomInt(NICKNAME_NUMBER_MIN, NICKNAME_NUMBER_MAX + 1);
  return `${adjective} ${animal} ${number}`;
}
