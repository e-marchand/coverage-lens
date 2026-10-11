// The same cases as common/Python/tu/tests/test_coverage_db.py, so both tools agree.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoverageDatabase } from '../src/coverage';
import { Changes, parseUnifiedDiff } from '../src/diff';
import { innermost, selectionMarkdown, selectTests } from '../src/units';

const DIFF = `diff --git a/4D/Sources/a.cpp b/4D/Sources/a.cpp
--- a/4D/Sources/a.cpp
+++ b/4D/Sources/a.cpp
@@ -12 +12 @@ void f()
-  old();
+  new();
@@ -30,0 +31,2 @@ void g()
+  added();
+  --counter;
--- /dev/null
+++ b/4D/Sources/new.cpp
@@ -0,0 +1,2 @@
+int h() {
+}
`;

function plain(changes: Changes) {
    return Object.fromEntries([...changes].map(([p, c]) => [p, [[...c.changed].sort(), [...c.inserted].sort()]]));
}

test('parseUnifiedDiff maps changes to old lines', () => {
    assert.deepEqual(plain(parseUnifiedDiff(DIFF)), {
        '4D/Sources/a.cpp': [[12], [31]],
        '4D/Sources/new.cpp': [[], [1]],
    });
});

test('parseUnifiedDiff with context lines', () => {
    const diff = ['--- a/x.cpp', '+++ b/x.cpp', '@@ -5,4 +5,5 @@', ' a', '-b', '+B', ' c', '+new', '--- d', '+d'].join('\n');
    assert.deepEqual(plain(parseUnifiedDiff(diff)), { 'x.cpp': [[6, 8], [8]] });
});

/** Four functions in two files; f2 has two instantiations of one source span. */
function modelDb(): CoverageDatabase {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-lens-')), 'm.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL);
        CREATE TABLE functions(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, demangled TEXT,
            file_id INTEGER, start_line INTEGER, end_line INTEGER);
        CREATE TABLE tests(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, profdata TEXT, ingested_at TEXT,
            functions_hit INTEGER, functions_new INTEGER, new_counters INTEGER, duration REAL);
        CREATE TABLE baseline(function_id INTEGER PRIMARY KEY, calls INTEGER, covered INTEGER, num_counters INTEGER);
        CREATE TABLE hits(test_id INTEGER NOT NULL, function_id INTEGER NOT NULL, calls INTEGER, extra_calls INTEGER,
            covered INTEGER, new_covered INTEGER, num_counters INTEGER, PRIMARY KEY(test_id, function_id)) WITHOUT ROWID;
        INSERT INTO files VALUES (1, '4D/Sources/a.cpp'), (2, '4D/Sources/b.cpp'), (3, 'ThirdParty/x.cpp');
        INSERT INTO functions VALUES (1, 'f1', 'f1()', 1, 1, 10), (2, 'f2a', 'f2<int>()', 1, 20, 29),
            (3, 'f2b', 'f2<long>()', 1, 20, 29), (4, 'g', 'g()', 2, 1, 50), (5, 'dark', 'dark()', 2, 60, 69),
            (6, 'tp', 'tp()', 3, 1, 5);
        INSERT INTO tests(id, name, new_counters, duration) VALUES (1, 'T1', 0, 10.0), (2, 'T2', 0, NULL), (3, 'T3', 0, 5.0);
        INSERT INTO hits(test_id, function_id, new_covered, covered) VALUES
            (1, 1, 3, 3), (1, 2, 2, 2), (2, 3, 1, 1), (2, 1, 1, 1), (3, 1, 0, 4);
        INSERT INTO baseline(function_id, covered) VALUES (4, 2);`);
    db.close();
    return new CoverageDatabase(file);
}

test('units fold instantiations and carry tests and startup', () => {
    const db = modelDb();
    const units = db.units('4D/Sources/a.cpp');
    assert.deepEqual(units.map(u => [u.start, u.name, Object.fromEntries(u.tests)]), [
        [1, 'f1()', { T1: 3, T2: 1 }], [20, 'f2<int>()', { T1: 2, T2: 1 }]]);
    const [g, dark] = db.units('4D/Sources/b.cpp');
    assert.equal(g.startup, true);
    assert.equal(dark.startup, false);
    assert.deepEqual([...db.durations], [['T1', 10], ['T3', 5]]);
    db.close();
});

test('resolve matches suffixes, and the longest one for an absolute path', () => {
    const db = modelDb();
    assert.deepEqual(db.resolve('Sources/a.cpp'), ['4D/Sources/a.cpp']);
    assert.deepEqual(db.resolve('/Users/me/4edimension/4D/Sources/a.cpp'), ['4D/Sources/a.cpp']);
    assert.deepEqual(db.resolve('C:\\src\\4D\\Sources\\b.cpp'), ['4D/Sources/b.cpp']);
    assert.deepEqual(db.resolve('other/a.cpp'), []);
    const units = db.unitsFor('/x/4D/Sources/a.cpp');
    assert.equal(innermost(units, 25)?.name, 'f2<int>()');
    assert.equal(innermost(units, 15), undefined);
    db.close();
});

test('selectTests from a diff', () => {
    const db = modelDb();
    const changes: Changes = new Map([
        ['Sources/a.cpp', { changed: new Set([5, 15]), inserted: new Set([25]) }],
        ['4D/Sources/b.cpp', { changed: new Set([65]), inserted: new Set<number>() }],
        ['4D/Sources/new.cpp', { changed: new Set<number>(), inserted: new Set([1]) }],
    ]);
    const selection = selectTests(db, changes);
    assert.deepEqual([...selection.touched].map(([u, n]) => [u.name, n]), [['f1()', 1], ['f2<int>()', 1], ['dark()', 1]]);
    assert.deepEqual(selection.tests.map(t => [t.name, t.units.length, t.counters, t.duration]),
        [['T1', 2, 5, 10], ['T2', 2, 2, undefined]]);
    assert.deepEqual(selection.untested.map(u => u.name), ['dark()']);
    assert.deepEqual([...selection.outside], [['Sources/a.cpp', 1]]);
    assert.deepEqual(selection.unknown, ['4D/Sources/new.cpp']);
    const text = selectionMarkdown(selection, 10);
    assert.ok(text.includes('| T1 | 2 | 5 |') && text.includes('`dark()`') && text.includes('never executed'));
    db.close();
});

test('an insertion at a function boundary selects nothing', () => {
    const db = modelDb();
    const selection = selectTests(db, new Map([['4D/Sources/a.cpp', { changed: new Set<number>(), inserted: new Set([11]) }]]));
    assert.equal(selection.touched.size, 0);
    assert.deepEqual([...selection.outside], [['4D/Sources/a.cpp', 1]]);
    db.close();
});

test('ignored paths are unknown, as in coverage_db.py', () => {
    const db = modelDb();
    const changes: Changes = new Map([['ThirdParty/x.cpp', { changed: new Set([2]), inserted: new Set<number>() }]]);
    assert.deepEqual(selectTests(db, changes, { ignore: /ThirdParty/ }).unknown, ['ThirdParty/x.cpp']);
    assert.equal(selectTests(db, changes).touched.size, 1);
    db.close();
});
