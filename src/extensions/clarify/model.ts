export type QuestionKind = "select" | "multi" | "input" | "confirm";

export interface ClarifyParams {
	title?: string;
	questions: ClarifyQuestionParam[];
}

export interface ClarifyQuestionParam {
	id: string;
	prompt: string;
	kind: QuestionKind;
	options?: ClarifyOption[];
	recommendation?: ClarifyRecommendation;
}

export interface ClarifyOption {
	value: string;
	label: string;
	description?: string;
}

export interface ClarifyRecommendation {
	values: string[];
	reason: string;
}

export interface NormalizedQuestion {
	id: string;
	label: string;
	prompt: string;
	kind: QuestionKind;
	options: ClarifyOption[];
	recommendation?: ClarifyRecommendation;
}

export interface AnswerState {
	selected: string[];
	custom?: string;
	input?: string;
	notes: Record<string, string>;
}

export interface ClarifyState {
	title?: string;
	questions: NormalizedQuestion[];
	activeTab: number;
	activeOption: number;
	answers: Record<string, AnswerState>;
}

export interface ClarifyAnswerResult {
	kind: QuestionKind;
	prompt: string;
	values: string[];
	labels: string[];
	custom?: string;
	input?: string;
	optionNotes?: Record<string, string>;
	recommendation?: ClarifyRecommendation & { accepted: boolean; labels: string[] };
}

export interface ClarifyResult {
	answers: Record<string, ClarifyAnswerResult>;
}

const confirmOptions: ClarifyOption[] = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];

export function normalizeParams(params: ClarifyParams): NormalizedQuestion[] {
	if (!Array.isArray(params.questions) || params.questions.length === 0) throw new Error("clarify requires questions");

	const ids = new Set<string>();
	return params.questions.map((question, index) => {
		const id = clean(question.id);
		if (!id) throw new Error(`clarify question ${index + 1} needs id`);
		if (ids.has(id)) throw new Error(`clarify duplicate question id: ${id}`);
		ids.add(id);

		const prompt = clean(question.prompt);
		if (!prompt) throw new Error(`clarify question ${id} needs prompt`);

		const kind = question.kind;
		if (!isQuestionKind(kind)) throw new Error(`clarify question ${id} has invalid kind`);

		const options = normalizeOptions(id, kind, question.options);
		const recommendation = normalizeRecommendation(id, kind, options, question.recommendation);

		return {
			id,
			label: labelFromId(id, index),
			prompt,
			kind,
			options,
			recommendation,
		};
	});
}

export function createState(title: string | undefined, questions: NormalizedQuestion[]): ClarifyState {
	return {
		title: clean(title),
		questions,
		activeTab: 0,
		activeOption: 0,
		answers: Object.fromEntries(questions.map((question) => [question.id, { selected: [], notes: {} }])),
	};
}

export function activeQuestion(state: ClarifyState): NormalizedQuestion | undefined {
	return state.questions[state.activeTab];
}

export function optionCount(question: NormalizedQuestion): number {
	return question.options.length + (hasCustom(question) ? 1 : 0);
}

export function hasCustom(question: NormalizedQuestion): boolean {
	return question.kind === "select" || question.kind === "multi";
}

export function moveTab(state: ClarifyState, direction: 1 | -1): ClarifyState {
	const tabCount = state.questions.length;
	return { ...state, activeTab: (state.activeTab + direction + tabCount) % tabCount, activeOption: 0 };
}

export function moveOption(state: ClarifyState, direction: 1 | -1): ClarifyState {
	const question = activeQuestion(state);
	if (!question) return state;
	const count = optionCount(question);
	if (count === 0) return state;
	return { ...state, activeOption: (state.activeOption + direction + count) % count };
}

export function toggleOrSelectOption(state: ClarifyState, question: NormalizedQuestion, value: string): ClarifyState {
	const answer = getAnswer(state, question.id);
	const selected = new Set(answer.selected);
	if (question.kind === "multi") {
		if (selected.has(value)) selected.delete(value);
		else selected.add(value);
		return putAnswer(state, question.id, { ...answer, selected: [...selected] });
	}
	return putAnswer(state, question.id, { ...answer, selected: [value], custom: undefined });
}

export function saveCustomAnswer(state: ClarifyState, question: NormalizedQuestion, value: string): ClarifyState {
	const trimmed = clean(value);
	const answer = getAnswer(state, question.id);
	if (!trimmed) return putAnswer(state, question.id, { ...answer, custom: undefined });
	const selected = question.kind === "select" ? [] : answer.selected;
	return putAnswer(state, question.id, { ...answer, selected, custom: trimmed });
}

export function saveInputAnswer(state: ClarifyState, question: NormalizedQuestion, value: string): ClarifyState {
	return putAnswer(state, question.id, { ...getAnswer(state, question.id), input: clean(value) });
}

export function saveOptionNote(
	state: ClarifyState,
	question: NormalizedQuestion,
	value: string,
	note: string,
): ClarifyState {
	const answer = getAnswer(state, question.id);
	const notes = { ...answer.notes };
	const trimmed = clean(note);
	if (trimmed) notes[value] = trimmed;
	else delete notes[value];
	return putAnswer(state, question.id, { ...answer, notes });
}

export function isAnswered(state: ClarifyState, question: NormalizedQuestion): boolean {
	const answer = getAnswer(state, question.id);
	if (question.kind === "input") return Boolean(clean(answer.input));
	if (question.kind === "select" || question.kind === "confirm")
		return answer.selected.length === 1 || Boolean(answer.custom);
	return answer.selected.length > 0 || Boolean(answer.custom);
}

export function buildResult(state: ClarifyState): ClarifyResult {
	return {
		answers: Object.fromEntries(state.questions.map((question) => [question.id, buildAnswer(state, question)])),
	};
}

export function getAnswer(state: ClarifyState, questionId: string): AnswerState {
	return state.answers[questionId] ?? { selected: [], notes: {} };
}

function buildAnswer(state: ClarifyState, question: NormalizedQuestion): ClarifyAnswerResult {
	const answer = getAnswer(state, question.id);
	const selectedOptions = answer.selected.map((value) => optionByValue(question, value)).filter(isOption);
	const optionNotes = Object.fromEntries(
		selectedOptions.flatMap((option) => {
			const note = answer.notes[option.value];
			return note ? [[option.value, note]] : [];
		}),
	);
	const values = selectedOptions.map((option) => option.value);
	const labels = selectedOptions.map((option) => option.label);
	if (answer.custom) {
		values.push(answer.custom);
		labels.push(answer.custom);
	}
	if (question.kind === "input" && answer.input) {
		values.push(answer.input);
		labels.push(answer.input);
	}

	return dropUndefined({
		kind: question.kind,
		prompt: question.prompt,
		values,
		labels,
		custom: answer.custom,
		input: question.kind === "input" ? answer.input : undefined,
		optionNotes: Object.keys(optionNotes).length ? optionNotes : undefined,
		recommendation: question.recommendation
			? {
					...question.recommendation,
					accepted: sameValues(values, question.recommendation.values),
					labels: question.recommendation.values.map((value) => optionByValue(question, value)?.label ?? value),
				}
			: undefined,
	});
}

function putAnswer(state: ClarifyState, questionId: string, answer: AnswerState): ClarifyState {
	return { ...state, answers: { ...state.answers, [questionId]: answer } };
}

function normalizeOptions(id: string, kind: QuestionKind, options: ClarifyOption[] | undefined): ClarifyOption[] {
	if (kind === "confirm") {
		if (options && options.length > 0) throw new Error(`clarify confirm question ${id} cannot provide options`);
		return confirmOptions;
	}
	if (kind === "input") {
		if (options && options.length > 0) throw new Error(`clarify input question ${id} cannot provide options`);
		return [];
	}
	if (!options || options.length === 0) throw new Error(`clarify ${kind} question ${id} needs options`);

	const values = new Set<string>();
	return options.map((option, index) => {
		const value = clean(option.value);
		if (!value) throw new Error(`clarify question ${id} option ${index + 1} needs value`);
		if (values.has(value)) throw new Error(`clarify question ${id} duplicate option value: ${value}`);
		values.add(value);
		const label = clean(option.label);
		if (!label) throw new Error(`clarify question ${id} option ${value} needs label`);
		return dropUndefined({ value, label, description: clean(option.description) });
	});
}

function normalizeRecommendation(
	id: string,
	kind: QuestionKind,
	options: ClarifyOption[],
	recommendation: ClarifyRecommendation | undefined,
): ClarifyRecommendation | undefined {
	if (!recommendation) {
		if (kind === "input") return undefined;
		throw new Error(`clarify ${kind} question ${id} needs recommendation`);
	}
	const reason = clean(recommendation.reason);
	if (!reason) throw new Error(`clarify question ${id} recommendation needs reason`);
	const values = recommendation.values.map(clean).filter(Boolean);
	if (values.length === 0) throw new Error(`clarify question ${id} recommendation needs values`);
	if ((kind === "select" || kind === "confirm" || kind === "input") && values.length !== 1) {
		throw new Error(`clarify ${kind} question ${id} recommendation needs exactly one value`);
	}
	if (kind === "input") return { values, reason };
	const valid = new Set(options.map((option) => option.value));
	const unique = new Set<string>();
	for (const value of values) {
		if (!valid.has(value)) throw new Error(`clarify question ${id} recommendation value not in options: ${value}`);
		if (unique.has(value)) throw new Error(`clarify question ${id} duplicate recommendation value: ${value}`);
		unique.add(value);
	}
	return { values, reason };
}

function optionByValue(question: NormalizedQuestion, value: string): ClarifyOption | undefined {
	return question.options.find((option) => option.value === value);
}

function isQuestionKind(value: string): value is QuestionKind {
	return value === "select" || value === "multi" || value === "input" || value === "confirm";
}

function isOption(value: ClarifyOption | undefined): value is ClarifyOption {
	return value !== undefined;
}

function sameValues(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function labelFromId(id: string, index: number): string {
	const label = id
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.trim();
	return label || `Q${index + 1}`;
}

function clean(value: string | undefined): string {
	return value?.trim() ?? "";
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
