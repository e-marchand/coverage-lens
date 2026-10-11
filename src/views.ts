// The two side views: tests of the function at the cursor, and tests for a change.

import * as vscode from 'vscode';
import { CoverageState } from './state';
import {
    formatDuration, SelectedTest, Selection, shortName, testsOf, totalDuration, Unit, unitState,
} from './units';

const STATE_TEXT = {
    tested: '',
    startup: 'only 4D startup reaches it',
    dark: 'never executed',
};

function testItem(name: string, counters: number, duration: number | undefined): vscode.TreeItem {
    const item = new vscode.TreeItem(name);
    const time = formatDuration(duration);
    item.description = `${counters} counter${counters === 1 ? '' : 's'}${time ? ` · ${time}` : ''}`;
    item.tooltip = `${name}: ${counters} counter(s) beyond 4D startup${time ? `, runs in ${time}` : ''}`;
    item.iconPath = new vscode.ThemeIcon('beaker');
    item.contextValue = 'test';
    return item;
}

export interface TestElement {
    test: string;
}

/** Tests reaching the function at the cursor. */
export class FunctionView implements vscode.TreeDataProvider<TestElement>, vscode.Disposable {
    unit: Unit | undefined;
    private readonly view: vscode.TreeView<TestElement>;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: CoverageState) {
        this.view = vscode.window.createTreeView('coverageLens.function', { treeDataProvider: this });
    }

    dispose(): void {
        this.view.dispose();
        this.changed.dispose();
    }

    get tests(): string[] {
        return this.unit ? testsOf(this.unit).map(([test]) => test) : [];
    }

    /** `inCoveredFile`: the editor shows a file the database knows. */
    show(unit: Unit | undefined, inCoveredFile: boolean): void {
        if (unit === this.unit && unit) {
            return;
        }
        this.unit = unit;
        if (!this.state.db) {
            this.view.message = undefined;
        } else if (unit) {
            const state = unitState(unit);
            const where = `${unit.path}:${unit.start}`;
            this.view.message = state === 'tested'
                ? `${shortName(unit, 120)} — ${where} · ${unit.tests.size} test(s)`
                : `${shortName(unit, 120)} — ${where} · no test: ${STATE_TEXT[state]}`;
        } else {
            this.view.message = inCoveredFile ? 'The cursor is in no function the coverage build knows.' : undefined;
        }
        this.view.description = unit ? `${unit.tests.size} test(s)` : undefined;
        this.changed.fire();
    }

    getChildren(element?: TestElement): TestElement[] {
        return element || !this.unit ? [] : testsOf(this.unit).map(([test]) => ({ test }));
    }

    getTreeItem(element: TestElement): vscode.TreeItem {
        return testItem(element.test, this.unit?.tests.get(element.test) ?? 0, this.state.db?.durations.get(element.test));
    }
}

type Node =
    | { kind: 'group'; label: string; description: string; icon: string; children: Node[]; expanded: boolean }
    | { kind: 'test'; test: SelectedTest }
    | { kind: 'unit'; unit: Unit; description: string }
    | { kind: 'path'; path: string; description: string };

/** Tests to run for a working tree change, a commit or a branch. */
export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    selection: Selection | undefined;
    title = '';
    root: string | undefined;
    private nodes: Node[] = [];
    private readonly view: vscode.TreeView<Node>;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: CoverageState) {
        this.view = vscode.window.createTreeView('coverageLens.changes', { treeDataProvider: this });
    }

    dispose(): void {
        this.view.dispose();
        this.changed.dispose();
    }

    clear(): void {
        this.selection = undefined;
        this.nodes = [];
        this.view.message = undefined;
        this.view.description = undefined;
        this.changed.fire();
    }

    show(title: string, selection: Selection, root?: string): void {
        this.title = title;
        this.selection = selection;
        this.root = root;
        const files = new Set([...selection.touched.keys()].map(u => u.path));
        const nodes: Node[] = [];
        if (selection.tests.length) {
            const { seconds, unknown } = totalDuration(selection.tests);
            const time = seconds ? `~${formatDuration(seconds)}${unknown ? ` + ${unknown} without duration` : ''}` : '';
            nodes.push({
                kind: 'group', label: `Tests to run (${selection.tests.length})`, description: time,
                icon: 'beaker', expanded: true, children: selection.tests.map(test => ({ kind: 'test', test })),
            });
        }
        if (selection.untested.length) {
            nodes.push({
                kind: 'group', label: `Touched functions no test covers (${selection.untested.length})`,
                description: '', icon: 'warning', expanded: !selection.tests.length,
                children: selection.untested.map(unit => ({
                    kind: 'unit', unit, description: unit.startup ? 'only 4D startup reaches it' : 'never executed',
                })),
            });
        }
        const touched = [...selection.touched].filter(([unit]) => unit.tests.size)
            .sort(([a], [b]) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
        if (touched.length) {
            nodes.push({
                kind: 'group', label: `Touched functions with tests (${touched.length})`, description: '',
                icon: 'symbol-method', expanded: false,
                children: touched.map(([unit, lines]) => ({
                    kind: 'unit', unit,
                    description: `${unit.tests.size} test(s)${lines ? ` · ${lines} changed line(s)` : ''}`,
                })),
            });
        }
        const unknown: Node[] = [
            ...[...selection.outside].sort().map(([path, count]): Node => ({
                kind: 'path', path, description: `${count} line(s) outside any known function`,
            })),
            ...selection.unknown.map((path): Node => ({ kind: 'path', path, description: 'not in the coverage build' })),
        ];
        if (unknown.length) {
            nodes.push({
                kind: 'group', label: `Changes the coverage build knows no function for (${unknown.length})`,
                description: 'new code, declarations, other files', icon: 'question', expanded: false, children: unknown,
            });
        }
        this.nodes = nodes;
        this.view.description = title;
        this.view.message = selection.touched.size || unknown.length
            ? `${title}: ${selection.touched.size} function(s) in ${files.size} file(s), ` +
              `${selection.tests.length} test(s) reach them beyond 4D startup.`
            : `${title}: no change in a C++ function the coverage build knows.`;
        this.changed.fire();
        void vscode.commands.executeCommand('coverageLens.changes.focus');
    }

    getChildren(element?: Node): Node[] {
        if (!element) {
            return this.nodes;
        }
        if (element.kind === 'group') {
            return element.children;
        }
        if (element.kind === 'test') {
            return element.test.units.map(unit => ({
                kind: 'unit', unit, description: `${unit.tests.get(element.test.name) ?? 0} counter(s)`,
            }));
        }
        return [];
    }

    getTreeItem(element: Node): vscode.TreeItem {
        switch (element.kind) {
            case 'group': {
                const item = new vscode.TreeItem(element.label, element.expanded
                    ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                item.description = element.description;
                item.iconPath = new vscode.ThemeIcon(element.icon);
                return item;
            }
            case 'test': {
                const { test } = element;
                const item = testItem(test.name, test.counters, test.duration);
                item.description = `${test.units.length} function(s) · ${item.description}`;
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                return item;
            }
            case 'unit': {
                const { unit } = element;
                const item = new vscode.TreeItem(shortName(unit, 100));
                item.description = `${element.description} · ${unit.path.split('/').pop()}:${unit.start}`;
                item.tooltip = `${unit.name}\n${unit.path}:${unit.start}-${unit.end}`;
                item.iconPath = new vscode.ThemeIcon(unitState(unit) === 'tested' ? 'symbol-method' : 'circle-slash');
                item.command = { command: 'coverageLens.openUnit', title: 'Open', arguments: [unit, this.root] };
                return item;
            }
            case 'path': {
                const item = new vscode.TreeItem(element.path);
                item.description = element.description;
                item.iconPath = vscode.ThemeIcon.File;
                return item;
            }
        }
    }
}

/** The test name of a tree element, for item commands. */
export function testName(element: unknown): string | undefined {
    if (typeof element === 'string') {
        return element;
    }
    const node = element as { test?: string | SelectedTest } | undefined;
    return typeof node?.test === 'string' ? node.test : node?.test?.name;
}
