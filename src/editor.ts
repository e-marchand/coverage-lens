// Blame-like annotations in editors: a CodeLens per function, the current line, the gutter and the status bar.

import * as vscode from 'vscode';
import { CoverageState, setting } from './state';
import { FunctionView } from './views';
import { formatDuration, innermost, shortName, testsOf, Unit, unitState, UnitState } from './units';

const HOVER_TESTS = 20;

/** "12 tests: TQueries, TString, ORDA +9" */
export function testSummary(unit: Unit, names = setting<number>('inlineTestNames', 3)): string {
    switch (unitState(unit)) {
        case 'startup':
            return 'no test, only 4D startup reaches it';
        case 'dark':
            return 'no test reaches it';
        default: {
            const tests = testsOf(unit).map(([test]) => test);
            const shown = tests.slice(0, Math.max(names, 0));
            const more = tests.length - shown.length;
            const count = `${tests.length} test${tests.length === 1 ? '' : 's'}`;
            return shown.length ? `${count}: ${shown.join(', ')}${more ? ` +${more}` : ''}` : count;
        }
    }
}

export function unitHover(unit: Unit, durations: ReadonlyMap<string, number>, uri: vscode.Uri): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['coverageLens.showUnitTests', 'coverageLens.copyUnitTests'] };
    markdown.appendMarkdown(`**Coverage Lens** · \`${shortName(unit, 120)}\`\n\n`);
    const state = unitState(unit);
    if (state !== 'tested') {
        markdown.appendMarkdown(state === 'startup'
            ? 'No test reaches this function beyond 4D startup.'
            : 'Nothing executes this function: no test, not even 4D startup.');
        return markdown;
    }
    markdown.appendMarkdown(`${unit.tests.size} test(s) reach this function beyond 4D startup:\n\n`);
    markdown.appendMarkdown('| Test | Counters | Duration |\n|---|--:|--:|\n');
    const tests = testsOf(unit);
    for (const [test, counters] of tests.slice(0, HOVER_TESTS)) {
        markdown.appendMarkdown(`| ${test} | ${counters} | ${formatDuration(durations.get(test))} |\n`);
    }
    if (tests.length > HOVER_TESTS) {
        markdown.appendMarkdown(`| … ${tests.length - HOVER_TESTS} more | | |\n`);
    }
    const args = encodeURIComponent(JSON.stringify([uri.toString(), unit.start]));
    markdown.appendMarkdown(`\n[Copy test names](command:coverageLens.copyUnitTests?${args}) · ` +
        `[Pick tests…](command:coverageLens.showUnitTests?${args})`);
    return markdown;
}

/** Each line's state: the state of the innermost function containing it. */
function lineStates(units: readonly Unit[], lineCount: number): (UnitState | undefined)[] {
    const states: (UnitState | undefined)[] = new Array(lineCount);
    const bySize = [...units].sort((a, b) => (b.end - b.start) - (a.end - a.start));
    for (const unit of bySize) {
        const state = unitState(unit);
        for (let line = Math.max(unit.start, 1); line <= Math.min(unit.end, lineCount); line++) {
            states[line - 1] = state;
        }
    }
    return states;
}

export class EditorFeatures implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly lensesChanged = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.lensesChanged.event;
    private readonly currentLine = vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 3em',
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    private readonly gutter: Record<UnitState, vscode.TextEditorDecorationType>;
    private readonly status = vscode.window.createStatusBarItem('coverageLens.status', vscode.StatusBarAlignment.Right, 90);
    private readonly disposables: vscode.Disposable[] = [];
    private timer: NodeJS.Timeout | undefined;

    constructor(context: vscode.ExtensionContext, private readonly state: CoverageState,
                private readonly functionView: FunctionView) {
        const gutter = (state: UnitState, color: string) => vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `gutter-${state}.svg`),
            gutterIconSize: 'contain',
            isWholeLine: true,
            overviewRulerColor: color,
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        this.gutter = {
            tested: gutter('tested', '#2ea04399'),
            startup: gutter('startup', '#9e9e9e99'),
            dark: gutter('dark', '#e5534b99'),
        };
        this.status.name = 'Coverage Lens';
        this.disposables.push(
            vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh(true)),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor === vscode.window.activeTextEditor) {
                    this.schedule();
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.paintGutters()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('coverageLens')) {
                    this.lensesChanged.fire();
                    this.refresh(true);
                }
            }),
            state.onDidChange(() => {
                this.lensesChanged.fire();
                this.refresh(true);
            }),
        );
    }

    dispose(): void {
        clearTimeout(this.timer);
        for (const disposable of [...this.disposables, this.currentLine, ...Object.values(this.gutter),
            this.status, this.lensesChanged]) {
            disposable.dispose();
        }
    }

    unitsOf(document: vscode.TextDocument): Unit[] {
        return document.uri.scheme === 'file' ? this.state.unitsForFile(document.uri.fsPath) : [];
    }

    /** The innermost function at a 0-based line. */
    unitAt(document: vscode.TextDocument, line: number): Unit | undefined {
        return innermost(this.unitsOf(document), line + 1);
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!setting('codeLens', true)) {
            return [];
        }
        // One lens per start line, for the outermost function (lambdas share their parent's line).
        const byLine = new Map<number, Unit>();
        for (const unit of this.unitsOf(document)) {
            const known = byLine.get(unit.start);
            if (!known || unit.end > known.end) {
                byLine.set(unit.start, unit);
            }
        }
        const lenses: vscode.CodeLens[] = [];
        for (const unit of byLine.values()) {
            const line = Math.min(Math.max(unit.start - 1, 0), document.lineCount - 1);
            const icon = { tested: '$(beaker)', startup: '$(debug-disconnect)', dark: '$(circle-slash)' }[unitState(unit)];
            lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                title: `${icon} ${testSummary(unit)}`,
                tooltip: unit.name,
                command: 'coverageLens.showUnitTests',
                arguments: [document.uri.toString(), unit.start],
            }));
        }
        return lenses;
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(false), 80);
    }

    refresh(all: boolean): void {
        const editor = vscode.window.activeTextEditor;
        if (all) {
            this.paintGutters();
        }
        if (!editor || !this.state.db) {
            this.status.hide();
            editor?.setDecorations(this.currentLine, []);
            this.functionView.show(undefined, false);
            return;
        }
        const units = this.unitsOf(editor.document);
        const line = editor.selection.active.line;
        const unit = innermost(units, line + 1);
        this.functionView.show(unit, units.length > 0);
        if (!units.length) {
            this.status.hide();
            editor.setDecorations(this.currentLine, []);
            return;
        }
        this.status.text = unit
            ? `$(beaker) ${unit.tests.size ? `${unit.tests.size} test${unit.tests.size === 1 ? '' : 's'}` : 'no test'}`
            : '$(beaker) —';
        this.status.tooltip = unit ? `${shortName(unit, 120)}\n${testSummary(unit, 10)}` : 'The cursor is in no known function';
        this.status.command = unit ? { command: 'coverageLens.showUnitTests', title: 'Tests', arguments: [] } : undefined;
        this.status.show();

        if (!unit || !setting('currentLine', true) || !editor.selection.isEmpty) {
            editor.setDecorations(this.currentLine, []);
            return;
        }
        const end = editor.document.lineAt(line).range.end;
        editor.setDecorations(this.currentLine, [{
            range: new vscode.Range(end, end),
            hoverMessage: unitHover(unit, this.state.db.durations, editor.document.uri),
            renderOptions: { after: { contentText: testSummary(unit) } },
        }]);
    }

    private paintGutters(): void {
        const show = setting('gutter', false) && !!this.state.db;
        for (const editor of vscode.window.visibleTextEditors) {
            const ranges: Record<UnitState, vscode.Range[]> = { tested: [], startup: [], dark: [] };
            if (show) {
                const states = lineStates(this.unitsOf(editor.document), editor.document.lineCount);
                let start = 0;
                for (let line = 1; line <= states.length; line++) {
                    if (line === states.length || states[line] !== states[start]) {
                        const state = states[start];
                        if (state) {
                            ranges[state].push(new vscode.Range(start, 0, line - 1, 0));
                        }
                        start = line;
                    }
                }
            }
            for (const state of Object.keys(ranges) as UnitState[]) {
                editor.setDecorations(this.gutter[state], ranges[state]);
            }
        }
    }
}
