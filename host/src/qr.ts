// U5 (plan-004): dependency-free QR encoder for the pairing URI. Byte mode,
// error-correction level L, versions 1-10 (up to 271 payload bytes) — ample
// for `3dsendai://<psk>@<host>:<port>?token=<t>`. Implemented from the QR
// spec (ISO/IEC 18004) following the well-known qrcodegen structure; the
// cross-library proof is the C KAT in client/test/quirc_kat_test.c, where the
// vendored quirc decoder must recover the exact URI from a matrix this
// encoder produced (U6 shares the fixture).
//
// No new runtime dependency (AGENTS.md: libsodium-wrappers stays the only one).

/** Encoded symbol: size x size booleans, true = dark module. */
export interface QrMatrix {
	size: number;
	/** modules[row][col], true = dark */
	modules: boolean[][];
	version: number;
	mask: number;
}

// --- version tables (EC level L only) ---------------------------------------

// v1..v10: [ecCodewordsPerBlock, blocks as [count, dataCodewordsPerBlock][]]
const EC_L: Array<[number, Array<[number, number]>]> = [
	[7, [[1, 19]]],
	[10, [[1, 34]]],
	[15, [[1, 55]]],
	[20, [[1, 80]]],
	[26, [[1, 108]]],
	[18, [[2, 68]]],
	[20, [[2, 78]]],
	[24, [[2, 97]]],
	[30, [[2, 116]]],
	[
		18,
		[
			[2, 68],
			[2, 69],
		],
	],
];

// Alignment pattern center coordinates, v1..v10.
const ALIGN: number[][] = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
];

function dataCodewords(version: number): number {
	const [, blocks] = EC_L[version - 1]!;
	return blocks.reduce((n, [count, per]) => n + count * per, 0);
}

/** Max payload bytes for byte mode at level L (mode 4b + count 8b/16b). */
export function qrCapacity(version: number): number {
	const cw = dataCodewords(version);
	return version <= 9 ? cw - 2 : cw - 3;
}

// --- GF(256) Reed-Solomon (poly 0x11D) ---------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree: number): Uint8Array {
	let poly = new Uint8Array([1]);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] = next[j]! ^ gfMul(poly[j]!, GF_EXP[i]!);
			next[j + 1] = next[j + 1]! ^ poly[j]!;
		}
		poly = next;
	}
	return poly;
}

/** Compute `degree` EC codewords for a data block (polynomial remainder). */
function rsEncode(data: Uint8Array, degree: number): Uint8Array {
	const gen = rsGenerator(degree); // gen[j] = coeff of x^j (lowest first), gen[degree] = 1
	const rem = new Uint8Array(degree); // rem[0] = highest-degree coefficient
	for (const byte of data) {
		const factor = byte ^ rem[0]!;
		rem.copyWithin(0, 1);
		rem[degree - 1] = 0;
		// Subtract factor * generator; divisor taken highest-to-lowest, leading 1 excluded.
		for (let i = 0; i < degree; i++) rem[i] = rem[i]! ^ gfMul(gen[degree - 1 - i]!, factor);
	}
	return rem;
}

// --- bit assembly -------------------------------------------------------------

function buildCodewords(payload: Uint8Array, version: number): Uint8Array {
	const cwTotal = dataCodewords(version);
	const bits: number[] = [];
	const push = (value: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
	};
	push(0b0100, 4); // byte mode
	push(payload.length, version <= 9 ? 8 : 16);
	for (const b of payload) push(b, 8);
	// Terminator + pad to byte boundary + alternating pad bytes.
	const capacityBits = cwTotal * 8;
	push(0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);
	const out = new Uint8Array(cwTotal);
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
		out[i >> 3] = byte;
	}
	for (let i = bits.length / 8, alt = 0; i < cwTotal; i++, alt ^= 1) {
		out[i] = alt === 0 ? 0xec : 0x11;
	}
	return out;
}

/** Split into RS blocks, append ECC, and interleave per the spec. */
function interleave(codewords: Uint8Array, version: number): Uint8Array {
	const [ecPer, groups] = EC_L[version - 1]!;
	const dataBlocks: Uint8Array[] = [];
	let off = 0;
	for (const [count, per] of groups) {
		for (let i = 0; i < count; i++) {
			dataBlocks.push(codewords.subarray(off, off + per));
			off += per;
		}
	}
	const eccBlocks = dataBlocks.map((b) => rsEncode(b, ecPer));
	const out: number[] = [];
	const maxData = Math.max(...dataBlocks.map((b) => b.length));
	for (let i = 0; i < maxData; i++) {
		for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
	}
	for (let i = 0; i < ecPer; i++) {
		for (const b of eccBlocks) out.push(b[i]!);
	}
	return new Uint8Array(out);
}

// --- matrix construction -------------------------------------------------------

interface Grid {
	size: number;
	modules: boolean[][]; // dark
	isFunction: boolean[][];
}

function set(g: Grid, row: number, col: number, dark: boolean): void {
	g.modules[row]![col] = dark;
	g.isFunction[row]![col] = true;
}

function drawFinder(g: Grid, row: number, col: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const r = row + dy;
			const c = col + dx;
			if (r < 0 || r >= g.size || c < 0 || c >= g.size) continue;
			const dist = Math.max(Math.abs(dx), Math.abs(dy));
			set(g, r, c, dist !== 2 && dist !== 4); // rings: dark 3x3, light 5x5, dark 7x7, light separator
		}
	}
}

function drawAlignment(g: Grid, row: number, col: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			set(g, row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
}

function drawFunctionPatterns(g: Grid, version: number): void {
	// Timing patterns.
	for (let i = 0; i < g.size; i++) {
		set(g, 6, i, i % 2 === 0);
		set(g, i, 6, i % 2 === 0);
	}
	// Finders (overwrite timing at the corners).
	drawFinder(g, 3, 3);
	drawFinder(g, 3, g.size - 4);
	drawFinder(g, g.size - 4, 3);
	// Alignment patterns (skip the three finder corners).
	const centers = ALIGN[version - 1]!;
	for (const cy of centers) {
		for (const cx of centers) {
			const nearTL = cy <= 8 && cx <= 8;
			const nearTR = cy <= 8 && cx >= g.size - 9;
			const nearBL = cy >= g.size - 9 && cx <= 8;
			if (nearTL || nearTR || nearBL) continue;
			drawAlignment(g, cy, cx);
		}
	}
	drawFormatBits(g, 0); // reserve the areas (real bits drawn after masking)
	drawVersionBits(g, version);
}

// Format info: 5 data bits (EC level L = 0b01, then 3 mask bits) + 10 BCH bits,
// XORed with 0x5412. Placement follows the spec's two copies.
function drawFormatBits(g: Grid, mask: number): void {
	const data = (0b01 << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
	const bits = ((data << 10) | rem) ^ 0x5412;
	const bit = (i: number) => ((bits >> i) & 1) !== 0;
	// Copy 1: around the top-left finder.
	for (let i = 0; i <= 5; i++) set(g, i, 8, bit(i));
	set(g, 7, 8, bit(6));
	set(g, 8, 8, bit(7));
	set(g, 8, 7, bit(8));
	for (let i = 9; i < 15; i++) set(g, 8, 14 - i, bit(i));
	// Copy 2: split between top-right and bottom-left.
	for (let i = 0; i < 8; i++) set(g, 8, g.size - 1 - i, bit(i));
	for (let i = 8; i < 15; i++) set(g, g.size - 15 + i, 8, bit(i));
	set(g, g.size - 8, 8, true); // dark module
}

// Version info (v >= 7): 6 data bits + 12 BCH bits, two 3x6 copies.
function drawVersionBits(g: Grid, version: number): void {
	if (version < 7) return;
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
	const bits = (version << 12) | rem;
	for (let i = 0; i < 18; i++) {
		const dark = ((bits >> i) & 1) !== 0;
		const a = g.size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		set(g, a, b, dark); // bottom-left copy
		set(g, b, a, dark); // top-right copy
	}
}

// Zigzag data placement over non-function modules.
function drawData(g: Grid, data: Uint8Array): void {
	let i = 0;
	for (let right = g.size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < g.size; vert++) {
			for (let j = 0; j < 2; j++) {
				const col = right - j;
				const upward = ((right + 1) & 2) === 0;
				const row = upward ? g.size - 1 - vert : vert;
				if (!g.isFunction[row]![col] && i < data.length * 8) {
					g.modules[row]![col] = ((data[i >> 3]! >> (7 - (i & 7))) & 1) !== 0;
					i++;
				}
			}
		}
	}
}

function maskBit(mask: number, row: number, col: number): boolean {
	switch (mask) {
		case 0:
			return (row + col) % 2 === 0;
		case 1:
			return row % 2 === 0;
		case 2:
			return col % 3 === 0;
		case 3:
			return (row + col) % 3 === 0;
		case 4:
			return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5:
			return ((row * col) % 2) + ((row * col) % 3) === 0;
		case 6:
			return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
		default:
			return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
	}
}

function applyMask(g: Grid, mask: number): void {
	for (let r = 0; r < g.size; r++) {
		for (let c = 0; c < g.size; c++) {
			if (!g.isFunction[r]![c] && maskBit(mask, r, c)) g.modules[r]![c] = !g.modules[r]![c];
		}
	}
}

// Penalty score (N1 runs, N2 2x2 blocks, N3 finder-alikes, N4 balance).
function penalty(g: Grid): number {
	const n = g.size;
	let score = 0;
	const line = (get: (i: number) => boolean): number => {
		let s = 0;
		let run = 1;
		let str = get(0) ? "1" : "0";
		for (let i = 1; i < n; i++) {
			const d = get(i);
			str += d ? "1" : "0";
			if (d === get(i - 1)) {
				run++;
				if (run === 5) s += 3;
				else if (run > 5) s += 1;
			} else run = 1;
		}
		for (const pat of ["10111010000", "00001011101"]) {
			for (let at = str.indexOf(pat); at !== -1; at = str.indexOf(pat, at + 1)) s += 40;
		}
		return s;
	};
	for (let r = 0; r < n; r++) score += line((i) => g.modules[r]![i]!);
	for (let c = 0; c < n; c++) score += line((i) => g.modules[i]![c]!);
	let dark = 0;
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (g.modules[r]![c]) dark++;
			if (
				r + 1 < n &&
				c + 1 < n &&
				g.modules[r]![c] === g.modules[r]![c + 1] &&
				g.modules[r]![c] === g.modules[r + 1]![c] &&
				g.modules[r]![c] === g.modules[r + 1]![c + 1]
			)
				score += 3;
		}
	}
	const pct = (dark * 100) / (n * n);
	score += 10 * Math.floor(Math.abs(pct - 50) / 5);
	return score;
}

// --- public API ----------------------------------------------------------------

/** Encode text as a QR symbol (byte mode, EC level L, version 1-10). */
export function qrEncode(text: string): QrMatrix {
	const payload = new TextEncoder().encode(text);
	let version = 0;
	for (let v = 1; v <= 10; v++) {
		if (payload.length <= qrCapacity(v)) {
			version = v;
			break;
		}
	}
	if (version === 0) throw new Error(`payload too long for QR v10-L: ${payload.length} bytes`);

	const data = interleave(buildCodewords(payload, version), version);
	const size = 17 + 4 * version;
	const g: Grid = {
		size,
		modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
		isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
	};
	drawFunctionPatterns(g, version);
	drawData(g, data);

	let best = -1;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(g, mask);
		drawFormatBits(g, mask);
		const s = penalty(g);
		if (s < bestScore) {
			bestScore = s;
			best = mask;
		}
		applyMask(g, mask); // undo (mask XOR is its own inverse)
	}
	applyMask(g, best);
	drawFormatBits(g, best);
	return { size, modules: g.modules, version, mask: best };
}

/**
 * Render for a terminal: half-block characters, two module rows per text row,
 * light modules as blocks (dark modules = terminal background), with a
 * 2-module quiet zone.
 */
export function qrToTerminal(qr: QrMatrix): string {
	const quiet = 2;
	const total = qr.size + quiet * 2;
	const dark = (r: number, c: number): boolean => {
		const row = r - quiet;
		const col = c - quiet;
		if (row < 0 || row >= qr.size || col < 0 || col >= qr.size) return false; // quiet = light
		return qr.modules[row]![col]!;
	};
	const lines: string[] = [];
	for (let r = 0; r < total; r += 2) {
		let line = "";
		for (let c = 0; c < total; c++) {
			const top = !dark(r, c); // light?
			const bottom = r + 1 < total ? !dark(r + 1, c) : true;
			line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines.join("\n");
}

/**
 * Render as an 8-bit luma buffer (0 = black, 255 = white), `scale` pixels per
 * module plus a 4-module quiet zone — the shape quirc expects. Shared with the
 * U6 C KAT fixture generator.
 */
export function qrToLuma(
	qr: QrMatrix,
	scale = 4,
): { width: number; height: number; pixels: Uint8Array } {
	const quiet = 4;
	const total = (qr.size + quiet * 2) * scale;
	const pixels = new Uint8Array(total * total).fill(255);
	for (let r = 0; r < qr.size; r++) {
		for (let c = 0; c < qr.size; c++) {
			if (!qr.modules[r]![c]) continue;
			const y0 = (r + quiet) * scale;
			const x0 = (c + quiet) * scale;
			for (let dy = 0; dy < scale; dy++) {
				pixels.fill(0, (y0 + dy) * total + x0, (y0 + dy) * total + x0 + scale);
			}
		}
	}
	return { width: total, height: total, pixels };
}
