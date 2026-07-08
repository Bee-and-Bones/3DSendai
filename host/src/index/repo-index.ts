// Repo file index for grounded disambiguation (U16, deepens finding #11 / AE3).
// Whisper mangles code identifiers, so rather than trusting the transcript
// verbatim we fuzzy-match spoken filenames/symbols against the repo's real file
// list. This builds a tokenized index of repo-relative paths and ranks matches
// by token overlap, with an exact basename match ranking highest.

export interface RepoMatch {
	path: string;
	score: number;
}

interface IndexedFile {
	path: string;
	/** Lowercased basename without extension, e.g. "auth" for "middleware/auth.ts". */
	basename: string;
	/** Searchable tokens: path segments + basename + camel/kebab/snake splits. */
	tokens: Set<string>;
}

/** Split an identifier into lowercased word tokens (camelCase, kebab, snake, dots, slashes). */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.map((t) => t.toLowerCase())
		.filter((t) => t.length > 0);
}

function basenameNoExt(path: string): string {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

export class RepoIndex {
	private constructor(private readonly files: IndexedFile[]) {}

	static fromPaths(paths: string[]): RepoIndex {
		const files = paths.map((path) => {
			const base = basenameNoExt(path);
			const tokens = new Set<string>();
			for (const segment of path.split("/")) {
				for (const t of tokenize(segment)) tokens.add(t);
			}
			for (const t of tokenize(base)) tokens.add(t);
			return { path, basename: base.toLowerCase(), tokens };
		});
		return new RepoIndex(files);
	}

	get size(): number {
		return this.files.length;
	}

	/** Rank files against a free-text query. Case-insensitive; returns highest first. */
	search(query: string, limit = 3): RepoMatch[] {
		const words = tokenize(query);
		if (words.length === 0 || this.files.length === 0) return [];
		const queryWords = new Set(words);

		const scored: RepoMatch[] = [];
		for (const file of this.files) {
			let score = 0;
			for (const word of queryWords) {
				if (file.tokens.has(word)) score += 1;
			}
			// An exact basename spoken as a query word is the strongest signal.
			if (queryWords.has(file.basename)) score += 5;
			if (score > 0) scored.push({ path: file.path, score });
		}

		scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		return scored.slice(0, limit);
	}
}
