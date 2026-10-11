// Source functions ("units") and test selection, ported from coverage_db.py
// (CoverageModel, select_tests, selection_markdown). Nothing here needs SQLite.

import { Changes } from './diff';

/** One source function: a file and a line span. Template instantiations of the span are folded in. */
export interface Unit {
    readonly path: string;
    readonly start: number;
    readonly end: number;
    name: string;
    /** test -> counters it hits in the function beyond 4D startup. */
    readonly tests: Map<string, number>;
    /** 4D startup alone reaches the function. */
    startup: boolean;
}

export type UnitState = 'tested' | 'startup' | 'dark';

export function unitState(unit: Unit): UnitState {
    return unit.tests.size ? 'tested' : unit.startup ? 'startup' : 'dark';
}

export function unitLines(unit: Unit): number {
    return unit.end - unit.start + 1;
}

/** [test, counters], most counters first. */
export function testsOf(unit: Unit): [string, number][] {
    return [...unit.tests].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The smallest function containing `line`; with `inserted`, code added before `line` must fall inside the body. */
export function innermost(units: readonly Unit[], line: number, inserted = false): Unit | undefined {
    let best: Unit | undefined;
    for (const unit of units) {
        const inside = inserted ? unit.start < line && line <= unit.end : unit.start <= line && line <= unit.end;
        if (inside && (!best || unitLines(unit) < unitLines(best))) {
            best = unit;
        }
    }
    return best;
}

/** What selection needs from the coverage database. */
export interface UnitSource {
    readonly durations: ReadonlyMap<string, number>;
    /** Database paths naming the same file as `path`. */
    resolve(path: string): string[];
    /** The functions of a database path, by start line. */
    units(dbPath: string): Unit[];
}

export interface SelectedTest {
    name: string;
    /** Touched functions the test reaches. */
    units: Unit[];
    counters: number;
    duration?: number;
}

export interface Selection {
    /** Touched function -> changed lines in it. */
    touched: Map<Unit, number>;
    /** Most relevant first. */
    tests: SelectedTest[];
    /** Touched functions no test reaches beyond startup. */
    untested: Unit[];
    /** path -> changed lines in no known function. */
    outside: Map<string, number>;
    /** Changed paths the coverage build has no function in. */
    unknown: string[];
}

export interface SelectOptions {
    /** Database paths to leave out (ThirdParty, SDKs). */
    ignore?: RegExp;
    /** Functions selected whole, such as every function of a file. */
    units?: Iterable<Unit>;
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
    map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * The tests to run first for a change. A changed line selects the innermost
 * function containing it; a line inserted inside a function body selects that function.
 */
export function selectTests(source: UnitSource, changes: Changes, options: SelectOptions = {}): Selection {
    const touched = new Map<Unit, number>();
    const outside = new Map<string, number>();
    const unknown = new Set<string>();
    const ascending = (a: number, b: number) => a - b;
    for (const [path, { changed, inserted }] of changes) {
        const paths = source.resolve(path).filter(p => !options.ignore?.test(p)).sort();
        const units = paths.flatMap(p => source.units(p));
        if (!units.length) {
            unknown.add(path);
            continue;
        }
        for (const line of [...changed].sort(ascending)) {
            const unit = innermost(units, line);
            unit ? bump(touched, unit) : bump(outside, path);
        }
        for (const line of [...inserted].filter(l => !changed.has(l)).sort(ascending)) {
            const unit = innermost(units, line, true);
            unit ? bump(touched, unit) : bump(outside, path);
        }
    }
    for (const unit of options.units ?? []) {
        bump(touched, unit, 0);
    }

    const scores = new Map<string, SelectedTest>();
    for (const unit of touched.keys()) {
        for (const [test, counters] of unit.tests) {
            let score = scores.get(test);
            if (!score) {
                score = { name: test, units: [], counters: 0, duration: source.durations.get(test) };
                scores.set(test, score);
            }
            score.units.push(unit);
            score.counters += counters;
        }
    }
    const tests = [...scores.values()].sort((a, b) =>
        b.counters - a.counters || b.units.length - a.units.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const untested = [...touched.keys()].filter(u => !u.tests.size)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
    return { touched, tests, untested, outside, unknown: [...unknown].sort() };
}

export function formatDuration(seconds: number | undefined): string {
    if (seconds === undefined) {
        return '';
    }
    if (seconds < 90) {
        return `${Math.round(seconds)} s`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Total known duration and how many tests have none. */
export function totalDuration(tests: readonly { duration?: number }[]): { seconds: number; unknown: number } {
    let seconds = 0, unknown = 0;
    for (const test of tests) {
        test.duration === undefined ? unknown++ : (seconds += test.duration);
    }
    return { seconds, unknown };
}

const MAX_NAME = 200;

export function shortName(unit: Unit, max = MAX_NAME): string {
    return unit.name.length <= max ? unit.name : unit.name.slice(0, max - 1) + '…';
}

/** A Markdown report for a pull request, as `coverage_db.py select --format markdown`. */
export function selectionMarkdown(selection: Selection, limit = 50): string {
    const files = new Set([...selection.touched.keys()].map(u => u.path));
    const lines = ['### Tests covering this change', '',
        `This change touches **${selection.touched.size} function(s)** in **${files.size} file(s)**; ` +
        `**${selection.tests.length} test(s)** reach them beyond 4D startup.`, ''];
    if (selection.tests.length) {
        lines.push('| Test | Functions touched | New counters |', '|---|---:|---:|');
        for (const test of selection.tests.slice(0, limit)) {
            lines.push(`| ${test.name} | ${test.units.length} | ${test.counters} |`);
        }
        if (selection.tests.length > limit) {
            lines.push(`| … ${selection.tests.length - limit} more | | |`);
        }
        lines.push('');
    }
    if (selection.untested.length) {
        lines.push('**Touched functions no test covers:**');
        for (const unit of selection.untested.slice(0, limit)) {
            const why = unit.startup ? 'only 4D startup reaches it' : 'never executed';
            lines.push(`- \`${shortName(unit)}\` — \`${unit.path}:${unit.start}\` (${why})`);
        }
        lines.push('');
    }
    if (selection.outside.size || selection.unknown.length) {
        lines.push('**Changes the coverage build knows no function for** ' +
            '(new functions, declarations, or code not in the build):');
        for (const [path, count] of [...selection.outside].sort()) {
            lines.push(`- \`${path}\`: ${count} line(s)`);
        }
        for (const path of selection.unknown) {
            lines.push(`- \`${path}\`: whole file`);
        }
    }
    return lines.join('\n').trimEnd() + '\n';
}
