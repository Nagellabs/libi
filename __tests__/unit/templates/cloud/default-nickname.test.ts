import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodeCrypto from "node:crypto";
import { NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import { parseNickname } from "@/lib/templates/cloud/author-rules";
import {
  NICKNAME_ADJECTIVES,
  NICKNAME_ANIMALS,
  NICKNAME_NUMBER_MAX,
  NICKNAME_NUMBER_MIN,
  generateDefaultNickname,
  isExcludedNicknameNumber,
} from "@/lib/templates/cloud/default-nickname";

// Every draw must come from node:crypto: wrap randomInt so a test can see and steer it.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomInt: vi.fn(real.randomInt) };
});

afterEach(() => {
  vi.mocked(nodeCrypto.randomInt).mockClear();
});

const SHAPE = /^([A-Z][a-z]+) ([A-Z][a-z]+) ([1-9]\d{3})$/;

describe("generateDefaultNickname", () => {
  it('is "<Adjective> <Animal> <NNNN>" in Title Case, from the lists, and passes the site\'s rule', () => {
    for (let i = 0; i < 500; i++) {
      const n = generateDefaultNickname();
      const m = SHAPE.exec(n);
      expect(m, n).not.toBeNull();
      expect(NICKNAME_ADJECTIVES).toContain(m![1]);
      expect(NICKNAME_ANIMALS).toContain(m![2]);
      const num = Number(m![3]);
      expect(num).toBeGreaterThanOrEqual(NICKNAME_NUMBER_MIN);
      expect(num).toBeLessThanOrEqual(NICKNAME_NUMBER_MAX);
      expect(n).toMatch(NICKNAME_PATTERN);
      // Exactly what the nickname route would store: already trimmed and single-spaced.
      expect(parseNickname(n)).toEqual({ ok: true, nickname: n });
    }
  });

  it("every possible pairing fits the site's rule and its 32 characters, with the widest number", () => {
    let longest = 0;
    for (const adjective of NICKNAME_ADJECTIVES) {
      for (const animal of NICKNAME_ANIMALS) {
        const n = `${adjective} ${animal} ${NICKNAME_NUMBER_MAX}`;
        longest = Math.max(longest, n.length);
        if (!NICKNAME_PATTERN.test(n)) throw new Error(`"${n}" fails NICKNAME_PATTERN`);
      }
    }
    expect(longest).toBeLessThanOrEqual(32);
    expect(String(NICKNAME_NUMBER_MIN)).toHaveLength(4);
    expect(String(NICKNAME_NUMBER_MAX)).toHaveLength(4);
  });

  it("draws the adjective, the animal and the number from node:crypto's randomInt — never Math.random", () => {
    const mathRandom = vi.spyOn(Math, "random");
    const randomInt = vi.mocked(nodeCrypto.randomInt) as unknown as ReturnType<typeof vi.fn>;
    randomInt.mockImplementationOnce(() => 0).mockImplementationOnce(() => NICKNAME_ANIMALS.length - 1).mockImplementationOnce(() => 4821);
    expect(generateDefaultNickname()).toBe(`${NICKNAME_ADJECTIVES[0]} ${NICKNAME_ANIMALS[NICKNAME_ANIMALS.length - 1]} 4821`);
    expect(randomInt.mock.calls).toEqual([[NICKNAME_ADJECTIVES.length], [NICKNAME_ANIMALS.length], [NICKNAME_NUMBER_MIN, NICKNAME_NUMBER_MAX + 1]]);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it("never carries a hate code or a crude number: an excluded draw is drawn again", () => {
    for (const n of [1488, 1312, 1337, 1818, 2316, 6666, 6969, 8008, 8814, 4200, 4209, 1988, 8812, 3880]) expect(isExcludedNicknameNumber(n), String(n)).toBe(true);
    for (const n of [1000, 4821, 9999, 1234, 4210, 1420]) expect(isExcludedNicknameNumber(n), String(n)).toBe(false);
    const randomInt = vi.mocked(nodeCrypto.randomInt) as unknown as ReturnType<typeof vi.fn>;
    randomInt.mockImplementationOnce(() => 0).mockImplementationOnce(() => 0).mockImplementationOnce(() => 1488).mockImplementationOnce(() => 6969).mockImplementationOnce(() => 4821);
    expect(generateDefaultNickname()).toBe(`${NICKNAME_ADJECTIVES[0]} ${NICKNAME_ANIMALS[0]} 4821`);
    // Over many real draws, no excluded number ever appears.
    for (let i = 0; i < 2000; i++) {
      const n = Number(generateDefaultNickname().split(" ").at(-1));
      if (isExcludedNicknameNumber(n)) throw new Error(`drew ${n}`);
    }
  });

  it("varies: 200 draws are (nearly) all different", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateDefaultNickname()));
    expect(seen.size).toBeGreaterThan(195);
  });
});

describe("the word lists", () => {
  it("are big enough to read as random: 150+ words each", () => {
    expect(NICKNAME_ADJECTIVES.length).toBeGreaterThanOrEqual(150);
    expect(NICKNAME_ANIMALS.length).toBeGreaterThanOrEqual(150);
  });

  it("are one ASCII Title Case word each, with no duplicates within or across the lists", () => {
    for (const w of [...NICKNAME_ADJECTIVES, ...NICKNAME_ANIMALS]) expect(w).toMatch(/^[A-Z][a-z]{1,11}$/);
    expect(new Set(NICKNAME_ADJECTIVES).size).toBe(NICKNAME_ADJECTIVES.length);
    expect(new Set(NICKNAME_ANIMALS).size).toBe(NICKNAME_ANIMALS.length);
    const adjectives = new Set<string>(NICKNAME_ADJECTIVES);
    expect(NICKNAME_ANIMALS.filter((a) => adjectives.has(a))).toEqual([]);
  });

  // Not the curation itself — that is a human's call, word by word — but a
  // tripwire for the words already ruled out, and for substrings that make a
  // harmless word read badly ("Peacock", "Woodpecker").
  it("contain none of the words ruled out, and no word hiding a rude substring", () => {
    const RULED_OUT = [
      // insults, innuendo, slurs by association
      "Lazy", "Stupid", "Dumb", "Ugly", "Fat", "Crazy", "Angry", "Sexy", "Hot", "Naked", "Frisky", "Perky", "Spunky",
      "Pig", "Rat", "Snake", "Weasel", "Worm", "Slug", "Leech", "Cow", "Donkey", "Ass", "Mule", "Skunk", "Vulture",
      "Hyena", "Toad", "Shrew", "Tit", "Gorilla", "Monkey", "Ape", "Kitten", "Beaver", "Crab", "Hamster", "Cougar", "Booby",
      // political or loaded
      "Red", "Blue", "Black", "White", "Brown", "Yellow", "Proud", "Patriot", "Liberal", "Elephant", "Eagle", "Dove",
      "Hawk", "Crow", "Stormy", "Sturgeon",
      // brand and product names
      "Jaguar", "Puma", "Mustang", "Bronco", "Colt", "Impala", "Beetle", "Ram", "Viper", "Stingray", "Lynx", "Fox",
      "Camel", "Bobcat", "Llama", "Prime", "Sonic", "Mighty", "Goose", "Bull", "Ibis", "Owlet",
    ];
    const all = new Set<string>([...NICKNAME_ADJECTIVES, ...NICKNAME_ANIMALS]);
    expect(RULED_OUT.filter((w) => all.has(w))).toEqual([]);
    // Substrings no innocent word here needs. (Not "ass" or "tit": Grasshopper and Nightingale
    // are fine — those two are ruled out as whole words above.)
    const RUDE = /cock|pecker|dick|cum|sex|fag|piss|shit|fuck|crap|slut|porn|nazi|kill|dead|gun/i;
    expect([...all].filter((w) => RUDE.test(w))).toEqual([]);
  });
});
