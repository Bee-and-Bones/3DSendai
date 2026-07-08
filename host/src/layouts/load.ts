// Shareable `.pad` layout files (U20, R22). A `.pad` file is JSON describing a
// named macropad layout whose buttons carry AgentBus INTENTS, not agent-specific
// keystrokes, so one layout survives an agent swap.

export interface PadButton {
	id: string;
	label: string;
	intent: string;
}

export interface PadLayout {
	name: string;
	buttons: PadButton[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseButton(value: unknown, index: number): PadButton {
	if (!isRecord(value)) {
		throw new Error(`.pad button at index ${index} must be an object`);
	}
	for (const field of ["id", "label", "intent"] as const) {
		if (typeof value[field] !== "string" || value[field] === "") {
			throw new Error(`.pad button at index ${index} is missing a non-empty "${field}"`);
		}
	}
	return {
		id: value.id as string,
		label: value.label as string,
		intent: value.intent as string,
	};
}

/** Parse and validate `.pad` file text, throwing a clear Error on malformed input. */
export function parsePad(text: string): PadLayout {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`.pad file is not valid JSON: ${(err as Error).message}`);
	}
	if (!isRecord(raw)) {
		throw new Error(".pad file must be a JSON object");
	}
	if (typeof raw.name !== "string" || raw.name === "") {
		throw new Error('.pad file is missing a non-empty "name"');
	}
	if (!Array.isArray(raw.buttons)) {
		throw new Error('.pad file "buttons" must be an array');
	}
	return {
		name: raw.name,
		buttons: raw.buttons.map((b, i) => parseButton(b, i)),
	};
}

/** Load and parse a `.pad` layout file from disk. */
export async function loadPadFile(path: string): Promise<PadLayout> {
	const text = await Bun.file(path).text();
	return parsePad(text);
}
