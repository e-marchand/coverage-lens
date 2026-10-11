import * as vscode from 'vscode';
import * as path from 'node:path';
import { parseUnifiedDiff } from './diff';
import { EditorFeatures } from './editor';
import * as git from './git';
import { CoverageState, ignorePattern, SECTION, setting } from './state';
import { formatDuration, selectionMarkdown, selectTests, testsOf, totalDuration, Unit } from './units';
import { ChangesView, FunctionView, testName } from './views';

const TERMINAL = 'Coverage Lens';

/** What other extensions and the integration test can read. */
export interface CoverageLensApi {
    ready: Promise<void>;
    state: CoverageState;
    changes: ChangesView;
    function: FunctionView;
}

export function activate(context: vscode.ExtensionContext): CoverageLensApi {
    const log = vscode.window.createOutputChannel('Coverage Lens', { log: true });
    const state = new CoverageState(context.globalStorageUri, log);
    const functionView = new FunctionView(state);
    const changesView = new ChangesView(state);
    const editor = new EditorFeatures(context, state, functionView);
    context.subscriptions.push(log, state, functionView, changesView, editor);

    const command = (id: string, run: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
            try {
                await run(...args);
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                log.error(`${id}: ${text}`);
                void vscode.window.showErrorMessage(`Coverage Lens: ${text}`);
            }
        }));

    function database() {
        if (!state.db) {
            void vscode.window.showWarningMessage('Coverage Lens: no coverage database loaded.', 'Select Database…')
                .then(choice => choice && vscode.commands.executeCommand('coverageLens.selectDatabase'));
        }
        return state.db;
    }

    /** The function a command is about: (uri, start line) from a lens or hover, else the cursor. */
    function unitFor(uri?: string, start?: number): Unit | undefined {
        if (uri && start !== undefined) {
            return state.unitsForFile(vscode.Uri.parse(uri).fsPath).find(u => u.start === start);
        }
        const active = vscode.window.activeTextEditor;
        return active ? editor.unitAt(active.document, active.selection.active.line) : undefined;
    }

    async function copy(tests: string[]): Promise<void> {
        if (!tests.length) {
            void vscode.window.showInformationMessage('Coverage Lens: no test to copy.');
            return;
        }
        await vscode.env.clipboard.writeText(tests.join('\n'));
        const run = setting<string>('runCommand', '') ? ['Run'] : [];
        const choice = await vscode.window.showInformationMessage(
            `Coverage Lens: copied ${tests.length} test name(s).`, ...run);
        if (choice === 'Run') {
            await runTests(tests);
        }
    }

    async function runTests(tests: string[], cwd?: string): Promise<void> {
        const template = setting<string>('runCommand', '');
        if (!template) {
            const choice = await vscode.window.showInformationMessage(
                'Coverage Lens: set coverageLens.runCommand to run tests, e.g. "python3 tu_manager.py run ${tests}".',
                'Open Settings');
            if (choice) {
                await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.runCommand`);
            }
            return;
        }
        if (!tests.length) {
            return;
        }
        const text = template.replace(/\$\{tests\}/g, tests.join(' ')).replace(/\$\{testsComma\}/g, tests.join(','));
        const terminal = vscode.window.terminals.find(t => t.name === TERMINAL)
            ?? vscode.window.createTerminal({ name: TERMINAL, cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri });
        terminal.show();
        terminal.sendText(text);
    }

    async function currentRepo(): Promise<string> {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active?.scheme === 'file'
            ? path.dirname(active.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folder) {
            throw new Error('open a folder or a file of a git checkout first');
        }
        return git.repoRoot(folder);
    }

    async function select(title: string, produce: (root: string) => Promise<string | undefined>): Promise<void> {
        const db = database();
        if (!db) {
            return;
        }
        const root = await currentRepo();
        const text = await vscode.window.withProgress(
            { location: { viewId: 'coverageLens.changes' }, title }, () => produce(root));
        if (text === undefined) {
            return;
        }
        const selection = selectTests(db, parseUnifiedDiff(text), { ignore: ignorePattern() });
        changesView.show(title, selection, root);
        log.info(`${title}: ${selection.touched.size} function(s), ${selection.tests.length} test(s)`);
    }

    command('coverageLens.selectDatabase', async () => {
        const configuration = vscode.workspace.getConfiguration(SECTION);
        const current = configuration.get<string>('database', '');
        const choice = await vscode.window.showQuickPick([
            { label: '$(file) Choose a file…', id: 'file', description: 'a .sqlite made by coverage_db.py ingest' },
            { label: '$(globe) Enter a URL…', id: 'url', description: 'downloaded, then refreshed when the server has a newer one' },
        ], { title: 'Coverage database', placeHolder: current || 'No database yet' });
        let value: string | undefined;
        if (choice?.id === 'file') {
            const [file] = await vscode.window.showOpenDialog({
                title: 'Coverage database', canSelectMany: false, openLabel: 'Use Database',
                filters: { 'SQLite database': ['sqlite', 'sqlite3', 'db'], 'All files': ['*'] },
            }) ?? [];
            value = file?.fsPath;
        } else if (choice?.id === 'url') {
            value = await vscode.window.showInputBox({
                title: 'Coverage database URL',
                value: /^https?:/.test(current) ? current : 'http://',
                validateInput: text => (/^https?:\/\/\S+$/.test(text) ? undefined : 'an http:// or https:// URL'),
            });
        }
        if (!value) {
            return;
        }
        const inWorkspace = configuration.inspect('database')?.workspaceValue !== undefined;
        await configuration.update('database', value,
            inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        // The configuration listener loads it.
    });
    command('coverageLens.reload', () => state.load(true));
    command('coverageLens.info', () => {
        const db = database();
        if (!db) {
            return;
        }
        const withTime = db.durations.size;
        const lines = [
            `Database: ${db.file}`, state.origin !== db.file ? `From: ${state.origin}` : '',
            `${db.tests.length} tests (${withTime} with a duration), ${db.fileCount} source files`,
            `Built from: ${db.meta('app') ?? '?'}`, `Source root of the build: ${db.meta('source_root') ?? '?'}`,
        ].filter(Boolean);
        lines.forEach(line => log.info(line));
        log.show(true);
        void vscode.window.showInformationMessage(`Coverage Lens: ${db.tests.length} tests, ${db.fileCount} files.`);
    });

    command('coverageLens.showUnitTests', async (uri?: string, start?: number) => {
        const db = database();
        const unit = unitFor(uri, start);
        if (!db || !unit) {
            return;
        }
        if (!unit.tests.size) {
            void vscode.window.showInformationMessage(`Coverage Lens: no test reaches ${unit.name}` +
                (unit.startup ? ' beyond 4D startup.' : '; it never executes.'));
            return;
        }
        const picked = await vscode.window.showQuickPick(testsOf(unit).map(([test, counters]) => ({
            label: test,
            description: `${counters} counter(s)`,
            detail: formatDuration(db.durations.get(test)) || undefined,
        })), {
            title: `${unit.tests.size} test(s) reach ${unit.name.length > 80 ? unit.name.slice(0, 79) + '…' : unit.name}`,
            placeHolder: 'Pick tests to copy their names (Esc to close)',
            canPickMany: true,
            matchOnDescription: true,
        });
        if (picked?.length) {
            await copy(picked.map(item => item.label));
        }
    });
    command('coverageLens.copyUnitTests', (uri?: string, start?: number) => {
        const unit = unitFor(uri, start);
        return unit && copy(testsOf(unit).map(([test]) => test));
    });
    command('coverageLens.openUnit', (unit: Unit, root?: string) => state.openUnit(unit, root));

    command('coverageLens.selectWorkingTree', () =>
        select('Working tree vs HEAD', root => git.diff(root, ['HEAD'])));
    command('coverageLens.selectStaged', () =>
        select('Staged changes', root => git.diff(root, ['--cached'])));
    command('coverageLens.selectCommit', async (sha?: string) => {
        const root = await currentRepo();
        let commit = typeof sha === 'string' ? sha : undefined;
        if (!commit) {
            const commits = await git.recentCommits(root);
            const picked = await vscode.window.showQuickPick(commits.map(c => ({
                label: `$(git-commit) ${c.short} ${c.subject}`, description: `${c.author}, ${c.date}`, sha: c.sha,
            })), { title: 'Tests for a commit', placeHolder: 'Pick a commit', matchOnDescription: true });
            commit = picked?.sha;
        }
        if (commit) {
            const short = commit.slice(0, 8);
            await select(`Commit ${short}`, r => git.commitDiff(r, commit!));
        }
    });
    command('coverageLens.selectBranch', () => select('Branch changes', async root => {
        const configured = setting<string>('baseBranch', 'origin/main');
        for (const base of [configured, 'origin/main', 'main', 'origin/master', 'master']) {
            try {
                const mergeBase = (await git.git(root, ['merge-base', 'HEAD', base])).trim();
                log.info(`Branch changes: since ${base} (${mergeBase.slice(0, 8)}), working tree included`);
                return await git.diff(root, [mergeBase]);
            } catch {
                // Try the next base.
            }
        }
        throw new Error(`no merge base with ${configured}; set coverageLens.baseBranch`);
    }));
    command('coverageLens.selectFile', () => {
        const db = database();
        const active = vscode.window.activeTextEditor;
        if (!db || !active) {
            return;
        }
        const units = editor.unitsOf(active.document);
        if (!units.length) {
            void vscode.window.showInformationMessage('Coverage Lens: the coverage build knows no function in this file.');
            return;
        }
        changesView.show(`All of ${path.basename(active.document.uri.fsPath)}`, selectTests(db, new Map(), { units }));
    });
    command('coverageLens.clearSelection', () => changesView.clear());

    const selectionTests = () => changesView.selection?.tests.map(t => t.name) ?? [];
    command('coverageLens.copySelectionTests', () => copy(selectionTests()));
    command('coverageLens.copySelectionMarkdown', async () => {
        if (!changesView.selection) {
            return;
        }
        await vscode.env.clipboard.writeText(selectionMarkdown(changesView.selection));
        const { seconds } = totalDuration(changesView.selection.tests);
        void vscode.window.showInformationMessage(`Coverage Lens: copied the Markdown report` +
            (seconds ? ` (${formatDuration(seconds)} of known test time).` : '.'));
    });
    command('coverageLens.runSelectionTests', () => runTests(selectionTests(), changesView.root));
    command('coverageLens.copyFunctionTests', () => copy(functionView.tests));
    command('coverageLens.runFunctionTests', () => runTests(functionView.tests));
    command('coverageLens.copyTestName', (element: unknown) => {
        const name = testName(element);
        return name && vscode.env.clipboard.writeText(name);
    });
    command('coverageLens.runTest', (element: unknown) => {
        const name = testName(element);
        return name && runTests([name], changesView.root);
    });
    command('coverageLens.toggleGutter', () => toggle('gutter', false));
    command('coverageLens.toggleCurrentLine', () => toggle('currentLine', true));
    command('coverageLens.toggleCodeLens', () => toggle('codeLens', true));

    function toggle(key: string, fallback: boolean) {
        return vscode.workspace.getConfiguration(SECTION)
            .update(key, !setting(key, fallback), vscode.ConfigurationTarget.Global);
    }

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${SECTION}.database`)) {
            changesView.clear();
            void state.load();
        }
    }));
    return { ready: state.load(), state, changes: changesView, function: functionView };
}

export function deactivate(): void {
    // Disposables close the database.
}
