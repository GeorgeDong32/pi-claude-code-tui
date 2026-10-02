/**
 * Spinner verb pool + weighted sampling (2026-10-02).
 *
 * CC parity: the 187-verb list is byte-aligned with Claude Code's
 * src/constants/spinnerVerbs.ts (verified by diff — same words, same
 * order). CC samples uniformly with lodash `sample()`; the verb is picked
 * ONCE per run (Spinner.tsx `useState(() => sample(...))`) and never
 * rotates mid-run. The one deliberate substitution: CC's brand easter egg
 * "Clauding" becomes "Piing" (pi + -ing, same word-formation).
 *
 * pi-side enhancement (user-tuned): sampling is weighted, not uniform —
 *   staple verbs  w=3    (~1.5% each, every ~68 runs) — the most
 *                       CC-flavored classics, so daily use feels curated
 *   regular verbs w=1    (~0.5% each)
 *   easter eggs   w=0.25 (~0.12%, every ~800 runs) — rare on purpose
 * Pure module: RNG is injectable for deterministic tests.
 */

// --- 187 playful verbs (CC src/constants/spinnerVerbs.ts, Clauding→Piing) ---
export const SPINNER_VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming",
	"Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
	"Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing",
	"Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting",
	"Cerebrating", "Channeling", "Channelling", "Choreographing", "Churning",
	"Coalescing", "Cogitating", "Combobulating", "Composing", "Computing",
	"Concocting", "Considering", "Contemplating", "Cooking", "Crafting", "Creating",
	"Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating",
	"Determining", "Dilly-dallying", "Discombobulating", "Doing", "Doodling",
	"Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting",
	"Envisioning", "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling",
	"Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering",
	"Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping",
	"Garnishing", "Generating", "Gesticulating", "Germinating", "Gitifying",
	"Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding",
	"Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining",
	"Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
	"Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating",
	"Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing",
	"Misting", "Moonwalking", "Moseying", "Mulling", "Mustering", "Musing",
	"Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting",
	"Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing",
	"Philosophising", "Photosynthesizing", "Pollinating", "Pondering",
	"Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing",
	"Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
	"Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating",
	"Roosting", "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying",
	"Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
	"Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking",
	"Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping",
	"Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering",
	"Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring", "Transmuting",
	"Piing", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling",
	"Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
	"Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

/** High-frequency classics (w=3) — the most CC-flavored verbs, so daily
 * sampling feels curated instead of uniformly noisy. */
export const SPINNER_STAPLES: ReadonlySet<string> = new Set([
	"Baking", "Brewing", "Cooking", "Crafting",
	"Pondering", "Percolating", "Marinating", "Vibing",
]);

/** Rare brand easter eggs (w=0.25) — the pi counterpart of CC's Clauding. */
export const SPINNER_EGGS: readonly string[] = ["Piing"];

const STAPLE_WEIGHT = 3;
const REGULAR_WEIGHT = 1;
const EGG_WEIGHT = 0.25;

const verbWeight = (v: string): number => {
	if (SPINNER_EGGS.includes(v)) return EGG_WEIGHT;
	if (SPINNER_STAPLES.has(v)) return STAPLE_WEIGHT;
	return REGULAR_WEIGHT;
};

/** Weighted verb pick: staples ~3x, eggs ~1/4x, everything else uniform.
 * `rng` is injectable so tests can pin the draw deterministically. */
export function weightedVerbSample(rng: () => number = Math.random): string {
	const total = SPINNER_VERBS.reduce((sum, v) => sum + verbWeight(v), 0);
	let roll = rng() * total;
	for (const v of SPINNER_VERBS) {
		roll -= verbWeight(v);
		if (roll < 0) return v;
	}
	// rng() === 1.0 edge: fall through to the last verb.
	return SPINNER_VERBS[SPINNER_VERBS.length - 1]!;
}
