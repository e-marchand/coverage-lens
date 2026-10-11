// Read access to the per-test coverage database written by coverage_db.py.
// node:sqlite ships with the VS Code extension host (Node 22.13+), so there is no native module.

import { DatabaseSync, StatementSync } from 'node:sqlite';
import { sameFile } from './diff';
import { Unit, UnitSource } from './units';

const REQUIRED_TABLES = ['files', 'functions', 'tests', 'hits', 'baseline'];
const CACHE_SIZE = 64;

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

function isAbsolute(path: string): boolean {
    return /^([A-Za-z]:)?\//.test(path);
}

export class CoverageDatabase implements UnitSource {
    readonly tests: string[] = [];
    readonly durations = new Map<string, number>();
    readonly fileCount: number;
    private readonly db: DatabaseSync;
    private readonly testNames = new Map<number, string>();
    private readonly fileIds = new Map<string, number>();
    private readonly byBase = new Map<string, string[]>();
    private readonly cache = new Map<string, Unit[]>();
    private readonly functionsOf: StatementSync;
    private readonly hitsOf: StatementSync;
    private readonly baselineOf: StatementSync;

    constructor(readonly file: string) {
        this.db = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all().map(row => String(row.name)));
            for (const table of REQUIRED_TABLES) {
                if (!tables.has(table)) {
                    throw new Error(`${file} is not a coverage database (no "${table}" table)`);
                }
            }
            const hasDuration = this.db.prepare(
                "SELECT 1 FROM pragma_table_info('tests') WHERE name = 'duration'").get() !== undefined;
            for (const row of this.db.prepare(
                `SELECT id, name, ${hasDuration ? 'duration' : 'NULL AS duration'} FROM tests ORDER BY name`).all()) {
                const name = String(row.name);
                this.testNames.set(Number(row.id), name);
                this.tests.push(name);
                if (row.duration !== null) {
                    this.durations.set(name, Number(row.duration));
                }
            }
            for (const row of this.db.prepare('SELECT id, path FROM files').all()) {
                const path = String(row.path);
                this.fileIds.set(path, Number(row.id));
                const base = basename(path);
                const list = this.byBase.get(base);
                list ? list.push(path) : this.byBase.set(base, [path]);
            }
            this.fileCount = this.fileIds.size;
            this.functionsOf = this.db.prepare(
                'SELECT id, start_line, end_line, COALESCE(demangled, name) AS name FROM functions ' +
                'WHERE file_id = ? AND start_line IS NOT NULL ORDER BY start_line, end_line');
            this.hitsOf = this.db.prepare(
                'SELECT hits.test_id, hits.function_id, hits.new_covered FROM functions ' +
                'JOIN hits ON hits.function_id = functions.id ' +
                'WHERE functions.file_id = ? AND hits.new_covered > 0');
            this.baselineOf = this.db.prepare(
                'SELECT baseline.function_id FROM functions ' +
                'JOIN baseline ON baseline.function_id = functions.id ' +
                'WHERE functions.file_id = ? AND baseline.covered > 0');
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    close(): void {
        this.db.close();
    }

    meta(key: string): string | undefined {
        try {
            const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
            return row ? String(row.value) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Database paths naming the same file. An absolute path (an open editor)
     * gives the longest match only; a relative one (a git diff) gives them all.
     */
    resolve(path: string): string[] {
        const query = path.replace(/\\/g, '/');
        const candidates = (this.byBase.get(basename(query)) ?? []).filter(p => sameFile(p, query));
        if (candidates.includes(query)) {
            return [query];
        }
        if (isAbsolute(query) && candidates.length > 1) {
            return [candidates.reduce((a, b) => (b.length > a.length ? b : a))];
        }
        return candidates;
    }

    units(dbPath: string): Unit[] {
        const cached = this.cache.get(dbPath);
        if (cached) {
            this.cache.delete(dbPath);
            this.cache.set(dbPath, cached);
            return cached;
        }
        const fileId = this.fileIds.get(dbPath);
        if (fileId === undefined) {
            return [];
        }
        const units: Unit[] = [];
        const byKey = new Map<string, Unit>();
        const unitOf = new Map<number, Unit>();
        for (const row of this.functionsOf.all(fileId)) {
            const start = Number(row.start_line);
            const end = row.end_line === null ? start : Number(row.end_line);
            const name = String(row.name);
            const key = `${start}:${end}`;
            let unit = byKey.get(key);
            if (!unit) {
                unit = { path: dbPath, start, end, name, tests: new Map(), startup: false };
                byKey.set(key, unit);
                units.push(unit);
            } else if (name.length < unit.name.length) {
                unit.name = name;
            }
            unitOf.set(Number(row.id), unit);
        }
        for (const row of this.hitsOf.all(fileId)) {
            const unit = unitOf.get(Number(row.function_id));
            const test = this.testNames.get(Number(row.test_id));
            if (unit && test) {
                unit.tests.set(test, (unit.tests.get(test) ?? 0) + Number(row.new_covered));
            }
        }
        for (const row of this.baselineOf.all(fileId)) {
            const unit = unitOf.get(Number(row.function_id));
            if (unit) {
                unit.startup = true;
            }
        }
        this.cache.set(dbPath, units);
        if (this.cache.size > CACHE_SIZE) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        return units;
    }

    /** The functions of the file at `path`, by start line. */
    unitsFor(path: string): Unit[] {
        const paths = this.resolve(path);
        if (paths.length === 1) {
            return this.units(paths[0]);
        }
        return paths.sort().flatMap(p => this.units(p)).sort((a, b) => a.start - b.start || a.end - b.end);
    }
}
